import { prisma } from "../config/prisma";
import { binance, BinanceError } from "../lib/binance";
import { logger } from "../lib/logger";
import { broadcast } from "../websocket/ws.server";
import { PatternResult } from "./strategy.service";
import type { TrendEntry } from "./trend.service";
import { resolveTrendCfg } from "./trend.service";
import { getCurrentRegime } from "./liveRegime.service";

/**
 * Quản lý vòng đời lệnh:
 *  - openLongFromSignal: đặt LONG MARKET, tạo Position + cập nhật Signal.
 *  - monitorPositions: cập nhật PNL realtime, tự đóng khi chạm TP/SL.
 *  - closePosition: đóng lệnh, ghi Trade + log.
 */

export async function getSettings() {
  let s = await prisma.settings.findFirst();
  if (!s) {
    s = await prisma.settings.create({ data: {} });
  }
  return s;
}

/**
 * Tính giá TP/SL từ giá vào theo chế độ:
 *  - MARGIN: TP/SL là % trên ký quỹ (ROI) -> %giá = pct/đòn bẩy.
 *  - PRICE: TP/SL là % biến động giá trực tiếp.
 */
function calcTpSl(entry: number, settings: { takeProfitPct: number; stopLossPct: number; leverage: number; tpSlMode: string }) {
  const lev = settings.tpSlMode === "MARGIN" ? settings.leverage : 1;
  const tpMove = settings.takeProfitPct / lev;
  const slMove = settings.stopLossPct / lev;
  return { tp: entry * (1 + tpMove / 100), sl: entry * (1 - slMove / 100) };
}

/** Tính khối lượng (quantity) từ orderSizeUsdt và đòn bẩy, làm tròn theo precision */
function calcQuantity(orderSizeUsdt: number, leverage: number, price: number, qtyPrecision: number) {
  const notional = orderSizeUsdt * leverage;
  const qty = notional / price;
  const factor = 10 ** qtyPrecision;
  return Math.floor(qty * factor) / factor;
}

export async function openLongFromSignal(signalId: number): Promise<void> {
  const signal = await prisma.signal.findUnique({
    where: { id: signalId },
    include: { coin: true },
  });
  if (!signal || signal.status !== "PENDING") return;

  const settings = await getSettings();

  // Tránh mở trùng vị thế cho cùng 1 symbol
  const existingOpen = await prisma.position.findFirst({
    where: { symbol: signal.symbol, status: "OPEN" },
  });
  if (existingOpen) {
    logger.warn("trading", `Đã có vị thế OPEN cho ${signal.symbol}, bỏ qua signal #${signalId}`);
    await prisma.signal.update({ where: { id: signalId }, data: { status: "CANCELLED" } });
    return;
  }

  const qty = calcQuantity(
    settings.orderSizeUsdt,
    settings.leverage,
    signal.entryPrice,
    signal.coin.qtyPrecision
  );
  if (qty <= 0) {
    logger.error("trading", `Khối lượng tính ra <= 0 cho ${signal.symbol}`);
    return;
  }

  try {
    binance.setCredentials(settings.binanceApiKey, settings.binanceApiSecret);
    await binance.setMarginType(signal.symbol, settings.marginMode === "ISOLATED" ? "ISOLATED" : "CROSS");
    await binance.setLeverage(signal.symbol, settings.leverage);
    const order = await binance.placeMarketOrder(signal.symbol, "BUY", qty);

    const fillPrice = parseFloat(order.avgPrice) || signal.entryPrice;
    const { tp, sl } = calcTpSl(fillPrice, settings);

    const position = await prisma.position.create({
      data: {
        coinId: signal.coinId,
        signalId: signal.id,
        symbol: signal.symbol,
        side: "LONG",
        status: "OPEN",
        entryPrice: fillPrice,
        quantity: qty,
        takeProfit: tp,
        stopLoss: sl,
        leverage: settings.leverage,
        currentPrice: fillPrice,
        binanceOrderId: String(order.orderId),
      },
    });

    await prisma.signal.update({ where: { id: signal.id }, data: { status: "EXECUTED" } });

    logger.info("trading", `Mở LONG ${signal.symbol} @ ${fillPrice} qty=${qty}`, {
      tp,
      sl,
      positionId: position.id,
    });
    broadcast({ type: "position_opened", data: position });
  } catch (err) {
    const msg = err instanceof BinanceError ? err.message : String(err);
    logger.error("trading", `Mở lệnh ${signal.symbol} thất bại: ${msg}`);
    await prisma.signal.update({ where: { id: signal.id }, data: { status: "CANCELLED" } });
  }
}

/** Tính PNL theo chiều (LONG/SHORT) */
function calcPnl(entry: number, current: number, qty: number, leverage: number, side = "LONG") {
  const dir = side === "SHORT" ? -1 : 1;
  const pnl = (current - entry) * qty * dir;
  const pnlPct = ((current - entry) / entry) * 100 * leverage * dir;
  return { pnl, pnlPct };
}

/**
 * Cập nhật giá + PNL cho toàn bộ vị thế OPEN, tự đóng khi chạm TP/SL.
 * priceMap: symbol -> giá hiện tại (lấy từ scanner / websocket).
 */
export async function monitorPositions(priceMap: Map<string, number>): Promise<void> {
  const open = await prisma.position.findMany({ where: { status: "OPEN" } });
  for (const pos of open) {
    const price = priceMap.get(pos.symbol);
    if (!price) continue;

    const { pnl, pnlPct } = calcPnl(pos.entryPrice, price, pos.quantity, pos.leverage);
    await prisma.position.update({
      where: { id: pos.id },
      data: { currentPrice: price, pnl, pnlPct },
    });

    if (price >= pos.takeProfit) {
      await closePosition(pos.id, price, "TP");
    } else if (price <= pos.stopLoss) {
      await closePosition(pos.id, price, "SL");
    } else {
      broadcast({
        type: "position_update",
        data: { id: pos.id, symbol: pos.symbol, currentPrice: price, pnl, pnlPct },
      });
    }
  }
}

export async function closePosition(
  positionId: number,
  exitPrice: number,
  reason: "TP" | "SL" | "TRAIL" | "FLIP" | "MANUAL"
): Promise<void> {
  const pos = await prisma.position.findUnique({ where: { id: positionId } });
  if (!pos || pos.status !== "OPEN") return;

  const settings = await getSettings();
  // PAPER: không gọi sàn. LIVE: đóng reduce-only đúng chiều.
  if (!pos.paper) {
    try {
      binance.setCredentials(settings.binanceApiKey, settings.binanceApiSecret);
      if (pos.side === "SHORT") {
        await binance.placeMarketOrder(pos.symbol, "BUY", pos.quantity);
      } else {
        await binance.closeLong(pos.symbol, pos.quantity);
      }
    } catch (err) {
      const msg = err instanceof BinanceError ? err.message : String(err);
      logger.warn("trading", `Lệnh đóng ${pos.symbol} trên sàn lỗi: ${msg}. Vẫn cập nhật DB.`);
    }
  }

  const { pnl, pnlPct } = calcPnl(pos.entryPrice, exitPrice, pos.quantity, pos.leverage, pos.side);

  await prisma.$transaction([
    prisma.position.update({
      where: { id: pos.id },
      data: { status: "CLOSED", currentPrice: exitPrice, pnl, pnlPct },
    }),
    prisma.trade.create({
      data: {
        coinId: pos.coinId,
        positionId: pos.id,
        symbol: pos.symbol,
        side: pos.side,
        entryPrice: pos.entryPrice,
        exitPrice,
        quantity: pos.quantity,
        pnl,
        pnlPct,
        closeReason: reason,
        paper: pos.paper,
        openedAt: pos.openedAt,
      },
    }),
  ]);

  logger.info("trading", `Đóng ${pos.symbol} (${reason}) PNL=${pnl.toFixed(2)} (${pnlPct.toFixed(2)}%)`);
  broadcast({ type: "position_closed", data: { id: pos.id, symbol: pos.symbol, reason, pnl, pnlPct } });
}

/** Tạo signal trong DB từ kết quả pattern + tự động trade nếu autoTrade bật */
export async function createSignalAndMaybeTrade(
  coinId: number,
  symbol: string,
  pattern: PatternResult
): Promise<void> {
  const settings = await getSettings();
  const { tp, sl } = calcTpSl(pattern.entryPrice, settings);

  // Chống tạo trùng signal trong 30 phút gần nhất
  const recent = await prisma.signal.findFirst({
    where: {
      symbol,
      detectedAt: { gte: new Date(Date.now() - 30 * 60 * 1000) },
    },
  });
  if (recent) return;

  const signal = await prisma.signal.create({
    data: {
      coinId,
      symbol,
      type: "LONG",
      status: "PENDING",
      entryPrice: pattern.entryPrice,
      takeProfit: tp,
      stopLoss: sl,
      probability: pattern.probability,
      reason: pattern.reason,
    },
  });

  logger.info("strategy", `Tín hiệu LONG ${symbol} @ ${pattern.entryPrice} (xác suất ${pattern.probability}%)`);
  broadcast({ type: "signal", data: signal });

  if (settings.autoTrade) {
    await openLongFromSignal(signal.id);
  }
}

// ===================== TREND FOLLOWING (paper/live auto-trade) =====================

/** Sizing cho TREND: R-based nếu riskPerTradePct>0 (rủi ro % số dư tại stop), else orderSizeUsdt. */
function calcTrendQty(
  entry: number,
  stop: number,
  settings: { orderSizeUsdt: number; leverage: number; riskPerTradePct: number },
  equityUsdt: number,
  qtyPrecision: number
): number {
  const riskDist = Math.abs(entry - stop);
  let notional: number;
  if (settings.riskPerTradePct > 0 && riskDist > 0) {
    const riskMoney = equityUsdt * (settings.riskPerTradePct / 100);
    notional = (riskMoney / riskDist) * entry; // qty*entry
    notional = Math.min(notional, equityUsdt * settings.leverage); // trần đòn bẩy
  } else {
    notional = settings.orderSizeUsdt * settings.leverage;
  }
  const qty = notional / entry;
  const factor = 10 ** qtyPrecision;
  return Math.floor(qty * factor) / factor;
}

/** Vốn mô phỏng hiện tại (paper) = vốn ban đầu giả định + tổng PnL đã đóng của lệnh paper. */
async function paperEquity(): Promise<number> {
  const base = 10000; // vốn paper mặc định
  const agg = await prisma.trade.aggregate({ _sum: { pnl: true }, where: { paper: true } });
  return base + (agg._sum.pnl ?? 0);
}

/**
 * Tạo tín hiệu TREND + tự vào lệnh (paper hoặc live) nếu autoTrade bật.
 * side = LONG/SHORT theo breakout; stop = ATR hard stop; trailing quản ở monitorPositions.
 */
export async function createTrendSignalAndMaybeTrade(
  coinId: number,
  symbol: string,
  sig: TrendEntry,
  qtyPrecision: number
): Promise<void> {
  const settings = await getSettings();

  // Chống trùng: đã có vị thế OPEN hoặc signal gần đây cho symbol này.
  const existing = await prisma.position.findFirst({ where: { symbol, status: "OPEN" } });
  if (existing) return;
  const recent = await prisma.signal.findFirst({
    where: { symbol, detectedAt: { gte: new Date(Date.now() - 30 * 60 * 1000) } },
  });
  if (recent) return;

  const signal = await prisma.signal.create({
    data: {
      coinId,
      symbol,
      type: sig.side,
      status: "PENDING",
      entryPrice: sig.entry,
      takeProfit: 0, // TREND không dùng TP cố định — thoát bằng trailing/stop
      stopLoss: sig.stop,
      probability: Math.min(100, Math.round(sig.adx)),
      reason: sig.reason,
    },
  });
  logger.info("strategy", `Tín hiệu TREND ${sig.side} ${symbol} @ ${sig.entry} (ADX ${sig.adx.toFixed(0)})`);
  broadcast({ type: "signal", data: signal });

  if (!settings.autoTrade) return;

  const paper = settings.paperTrade;
  const equity = paper ? await paperEquity() : settings.orderSizeUsdt * 20; // ước lượng cho live sizing
  const qty = calcTrendQty(sig.entry, sig.stop, settings, equity, qtyPrecision);
  if (qty <= 0) {
    logger.warn("trading", `TREND qty<=0 ${symbol}`);
    await prisma.signal.update({ where: { id: signal.id }, data: { status: "CANCELLED" } });
    return;
  }

  let fillPrice = sig.entry;
  if (!paper) {
    try {
      binance.setCredentials(settings.binanceApiKey, settings.binanceApiSecret);
      await binance.setMarginType(symbol, settings.marginMode === "ISOLATED" ? "ISOLATED" : "CROSS");
      await binance.setLeverage(symbol, settings.leverage);
      const order = await binance.placeMarketOrder(symbol, sig.side === "SHORT" ? "SELL" : "BUY", qty);
      fillPrice = parseFloat(order.avgPrice) || sig.entry;
    } catch (err) {
      const msg = err instanceof BinanceError ? err.message : String(err);
      logger.error("trading", `Mở TREND ${symbol} (live) lỗi: ${msg}`);
      await prisma.signal.update({ where: { id: signal.id }, data: { status: "CANCELLED" } });
      return;
    }
  }

  const position = await prisma.position.create({
    data: {
      coinId,
      signalId: signal.id,
      symbol,
      side: sig.side,
      status: "OPEN",
      entryPrice: fillPrice,
      quantity: qty,
      takeProfit: 0,
      stopLoss: sig.stop,
      leverage: settings.leverage,
      currentPrice: fillPrice,
      paper,
      atrEntry: sig.atr,
      highWater: fillPrice, // seed cực trị thuận lợi
    },
  });
  await prisma.signal.update({ where: { id: signal.id }, data: { status: "EXECUTED" } });
  logger.info("trading", `${paper ? "[PAPER] " : ""}Mở ${sig.side} ${symbol} @ ${fillPrice} qty=${qty} stop=${sig.stop.toFixed(6)}`);
  broadcast({ type: "position_opened", data: position });
}

/**
 * Quản lý vị thế TREND: cập nhật giá/PnL + trailing Chandelier + hard stop + regime-flip.
 * Dùng thay monitorPositions khi strategyMode=TREND. Trailing dời stop theo cực trị thuận lợi.
 */
export async function monitorTrendPositions(priceMap: Map<string, number>, k2Atr: number, regimeMode = "BTC1H_ALT1H"): Promise<void> {
  const open = await prisma.position.findMany({ where: { status: "OPEN" } });
  if (!open.length) return;
  const regime = await getCurrentRegime(regimeMode);

  for (const pos of open) {
    const price = priceMap.get(pos.symbol);
    if (!price) continue;
    const long = pos.side !== "SHORT";
    const atr = pos.atrEntry ?? 0;

    // Cập nhật cực trị thuận lợi (high-water) + trailing Chandelier.
    let hw = pos.highWater ?? pos.entryPrice;
    hw = long ? Math.max(hw, price) : Math.min(hw, price);
    let newStop = pos.stopLoss;
    if (atr > 0) {
      const chandelier = long ? hw - k2Atr * atr : hw + k2Atr * atr;
      newStop = long ? Math.max(pos.stopLoss, chandelier) : Math.min(pos.stopLoss, chandelier);
    }

    const { pnl, pnlPct } = calcPnl(pos.entryPrice, price, pos.quantity, pos.leverage, pos.side);
    await prisma.position.update({
      where: { id: pos.id },
      data: { currentPrice: price, pnl, pnlPct, highWater: hw, stopLoss: newStop },
    });

    // Thoát: hard stop / trailing (đã gộp vào newStop) hoặc regime lật ngược.
    const hitStop = long ? price <= newStop : price >= newStop;
    const flipped = (long && regime === "SHORT") || (!long && regime === "LONG");
    if (hitStop) {
      await closePosition(pos.id, newStop, "TRAIL");
    } else if (flipped) {
      await closePosition(pos.id, price, "FLIP");
    } else {
      broadcast({ type: "position_update", data: { id: pos.id, symbol: pos.symbol, currentPrice: price, pnl, pnlPct } });
    }
  }
}
