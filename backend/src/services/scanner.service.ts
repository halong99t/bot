import { prisma } from "../config/prisma";
import { binance, Ticker24h } from "../lib/binance";
import { logger } from "../lib/logger";
import { computeIndicators } from "./indicators";
import { detectLongPattern } from "./strategy.service";
import { detectTrendEntry, resolveTrendCfg } from "./trend.service";
import { refreshRegime } from "./liveRegime.service";
import {
  createSignalAndMaybeTrade,
  monitorPositions,
  createTrendSignalAndMaybeTrade,
  monitorTrendPositions,
  getSettings,
} from "./trading.service";
import { broadcast } from "../websocket/ws.server";

/**
 * CHỨC NĂNG 1: Scan toàn bộ coin Binance Futures.
 * - Đồng bộ danh sách USDT perpetual vào bảng coins.
 * - Mỗi chu kỳ: lấy ticker 24h + funding + OI, tính chỉ báo, lưu market_data.
 * - Chạy phát hiện mô hình LONG.
 * - Cập nhật/đóng vị thế theo giá mới.
 */

// Giới hạn số symbol gọi klines mỗi chu kỳ để tránh rate-limit (xoay vòng).
const KLINE_BATCH = 40;
let klineCursor = 0;

let lastScanAt: Date | null = null;
let lastPriceMap = new Map<string, number>();

export function getScannerState() {
  return { lastScanAt, scanned: lastPriceMap.size };
}

/** Đồng bộ danh sách coin (gọi lúc khởi động và định kỳ) */
export async function syncCoins(): Promise<void> {
  const symbols = await binance.getUsdtPerpetualSymbols();
  logger.info("scanner", `Đồng bộ ${symbols.length} USDT perpetual symbols`);
  for (const s of symbols) {
    await prisma.coin.upsert({
      where: { symbol: s.symbol },
      update: {
        baseAsset: s.baseAsset,
        quoteAsset: s.quoteAsset,
        pricePrecision: s.pricePrecision,
        qtyPrecision: s.quantityPrecision,
        active: true,
      },
      create: {
        symbol: s.symbol,
        baseAsset: s.baseAsset,
        quoteAsset: s.quoteAsset,
        pricePrecision: s.pricePrecision,
        qtyPrecision: s.quantityPrecision,
        active: true,
      },
    });
  }

  // Vô hiệu hóa symbol không còn trên sàn (vd coin rác testnet cũ còn sót trong DB)
  const liveSymbols = symbols.map((s) => s.symbol);
  const deactivated = await prisma.coin.updateMany({
    where: { symbol: { notIn: liveSymbols }, active: true },
    data: { active: false },
  });
  if (deactivated.count > 0) {
    logger.info("scanner", `Vô hiệu hóa ${deactivated.count} symbol không còn trên sàn`);
  }
}

/** Một chu kỳ scan đầy đủ */
export async function runScanCycle(): Promise<void> {
  const start = Date.now();
  try {
    const [tickers, premium] = await Promise.all([
      binance.getAll24hTickers(),
      binance.getAllPremiumIndex(),
    ]);

    const fundingMap = new Map<string, number>();
    for (const p of premium) {
      fundingMap.set(p.symbol, parseFloat(p.lastFundingRate ?? "0"));
    }

    const coins = await prisma.coin.findMany({ where: { active: true } });
    const coinBySymbol = new Map(coins.map((c) => [c.symbol, c]));

    const tickerMap = new Map<string, Ticker24h>();
    for (const t of tickers) tickerMap.set(t.symbol, t);

    const priceMap = new Map<string, number>();

    // Chế độ chiến lược + regime (chỉ tính 1 lần/chu kỳ cho TREND)
    const settings = await getSettings().catch(() => null);
    const mode = settings?.strategyMode === "TREND" ? "TREND" : "LONG";
    const regimeMode = "BTC1H_ALT1H"; // mode duy nhất: regime BTC 1h → alt 1h
    const altIv = "1h"; // khung nến alt
    const trendCfg = resolveTrendCfg({ allowLong: true, allowShort: true });
    const regime = mode === "TREND" ? await refreshRegime(regimeMode) : "OFF";

    // Chọn batch symbol để lấy klines + OI chu kỳ này (xoay vòng)
    const symbols = coins.map((c) => c.symbol);
    const batch = nextBatch(symbols, KLINE_BATCH);

    // 1) Cập nhật market_data nhanh cho TẤT CẢ coin (chỉ ticker + funding)
    for (const coin of coins) {
      const t = tickerMap.get(coin.symbol);
      if (!t) continue;
      const price = parseFloat(t.lastPrice);
      priceMap.set(coin.symbol, price);
    }
    lastPriceMap = priceMap;

    // 2) Với batch: lấy klines, tính chỉ báo, OI, phát hiện pattern
    let signalsFound = 0;
    for (const symbol of batch) {
      const coin = coinBySymbol.get(symbol);
      const t = tickerMap.get(symbol);
      if (!coin || !t) continue;

      try {
        // TREND: khung alt theo regimeMode (15m hoặc 1h), 320 nến đủ EMA200; LONG dùng 15m như cũ.
        const klines = await binance.getKlines(symbol, mode === "TREND" ? altIv : "15m", mode === "TREND" ? 320 : 200);
        const ind = computeIndicators(klines);
        let openInterest: number | null = null;
        try {
          openInterest = await binance.getOpenInterest(symbol);
        } catch {
          openInterest = null;
        }

        await prisma.marketData.create({
          data: {
            coinId: coin.id,
            symbol,
            price: parseFloat(t.lastPrice),
            volume24h: parseFloat(t.volume),
            quoteVolume: parseFloat(t.quoteVolume),
            priceChange24h: parseFloat(t.priceChangePercent),
            fundingRate: fundingMap.get(symbol) ?? null,
            openInterest,
            atr: ind.atr,
            rsi: ind.rsi,
            ema20: ind.ema20,
            ema50: ind.ema50,
            ema200: ind.ema200,
          },
        });

        if (mode === "TREND") {
          // Tín hiệu breakout ở nến 1h mới nhất, cổng theo regime BTC.
          const entry = detectTrendEntry(klines, trendCfg, regime);
          if (entry) {
            await createTrendSignalAndMaybeTrade(coin.id, symbol, entry, coin.qtyPrecision);
            signalsFound++;
          }
        } else {
          // Phát hiện mô hình LONG (cũ)
          const pattern = detectLongPattern(klines);
          if (pattern.matched) {
            await createSignalAndMaybeTrade(coin.id, symbol, pattern);
            signalsFound++;
          }
        }
      } catch (err) {
        logger.warn("scanner", `Lỗi xử lý ${symbol}: ${String(err)}`);
      }
    }

    // 3) Cập nhật / đóng vị thế theo giá mới (TREND: trailing + regime-flip; LONG: TP/SL)
    if (mode === "TREND") {
      await monitorTrendPositions(priceMap, trendCfg.k2Atr, regimeMode);
    } else {
      await monitorPositions(priceMap);
    }

    lastScanAt = new Date();
    const took = Date.now() - start;
    logger.info(
      "scanner",
      `Scan xong: ${coins.length} coin, batch ${batch.length}, ${signalsFound} tín hiệu (${took}ms)`
    );
    broadcast({
      type: "scan_complete",
      data: { scanned: coins.length, signalsFound, tookMs: took, at: lastScanAt },
    });
  } catch (err) {
    logger.error("scanner", `Scan cycle lỗi: ${String(err)}`);
  }
}

function nextBatch(symbols: string[], size: number): string[] {
  if (symbols.length <= size) return symbols;
  const batch: string[] = [];
  for (let i = 0; i < size; i++) {
    batch.push(symbols[(klineCursor + i) % symbols.length]);
  }
  klineCursor = (klineCursor + size) % symbols.length;
  return batch;
}

// ===================== BẢNG XẾP HẠNG =====================

/** Lấy market_data mới nhất cho mỗi symbol */
async function latestMarketData() {
  // Dùng distinct on symbol theo createdAt desc
  const rows = await prisma.marketData.findMany({
    orderBy: { createdAt: "desc" },
    take: 2000,
  });
  const seen = new Set<string>();
  const latest: typeof rows = [];
  for (const r of rows) {
    if (!seen.has(r.symbol)) {
      seen.add(r.symbol);
      latest.push(r);
    }
  }
  return latest;
}

export async function getRankings() {
  const data = await latestMarketData();

  const topGainers = [...data]
    .sort((a, b) => b.priceChange24h - a.priceChange24h)
    .slice(0, 20);

  const topVolume = [...data].sort((a, b) => b.quoteVolume - a.quoteVolume).slice(0, 20);

  const topFunding = [...data]
    .filter((d) => d.fundingRate !== null)
    .sort((a, b) => Math.abs(b.fundingRate ?? 0) - Math.abs(a.fundingRate ?? 0))
    .slice(0, 20);

  const topOpenInterest = [...data]
    .filter((d) => d.openInterest !== null)
    .sort((a, b) => (b.openInterest ?? 0) - (a.openInterest ?? 0))
    .slice(0, 20);

  return { topGainers, topVolume, topFunding, topOpenInterest, all: data };
}
