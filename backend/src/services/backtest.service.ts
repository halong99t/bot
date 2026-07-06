import fs from "fs";
import path from "path";
import * as parquet from "@dsnp/parquetjs";
import { binance, Kline } from "../lib/binance";
import { detectLongPattern, StrategyParams } from "./strategy.service";
import { prisma } from "../config/prisma";
import { logger } from "../lib/logger";
import { env } from "../config/env";
import { classifySeries, EpsilonMode } from "./emaClassifier.service";
import { TrendParams, resolveTrendCfg, simulateSymbolTrend, RegimeAt } from "./trend.service";
import {
  getRegimeKlines,
  buildRegimeSeries,
  makeRegimeAt,
  computeBreadthByDay,
} from "./regime.service";
import { computeCorrelationClusters, clusterCount } from "./correlation.service";
import { MeanRevParams, resolveMeanRevCfg, simulateSymbolMeanRev } from "./meanReversion.service";

/**
 * Backtest chiến lược LONG trên dữ liệu lịch sử.
 * Mặc định: 3 tháng, khung nến 15 phút.
 *
 * Mô phỏng: tại mỗi nến đã đóng, chạy detectLongPattern trên toàn bộ lịch sử
 * tính tới nến đó. Khi khớp mô hình -> vào lệnh tại close nến breakout, rồi
 * "đi tới" các nến sau để xem chạm TP (+x%) hay SL (-y%) trước.
 * Không cho phép lệnh chồng lệnh trên cùng symbol.
 */

export interface BacktestParams extends StrategyParams {
  symbols?: string[];
  months?: number;
  fromMs?: number; // mốc bắt đầu (epoch ms) — ưu tiên hơn months
  toMs?: number; // mốc kết thúc (epoch ms)
  interval?: string;
  takeProfitPct?: number;
  stopLossPct?: number;
  maxSymbols?: number;
  initialCapitalUsdt?: number; // vốn ban đầu
  orderSizeUsdt?: number; // ký quỹ mỗi lệnh (chế độ cố định)
  positionSizePct?: number; // ký quỹ = % số dư hiện tại (chế độ compounding). >0 => ưu tiên chế độ này
  leverage?: number; // đòn bẩy
  marginMode?: "CROSS" | "ISOLATED"; // chế độ ký quỹ
  tpSlMode?: "PRICE" | "MARGIN"; // TP/SL theo % giá (PRICE) hay % ký quỹ/ROI (MARGIN)
  maxConcurrentPositions?: number; // trần vị thế mở đồng thời (vd 50). 0 = không giới hạn
  allSymbols?: boolean; // true = quét toàn bộ symbol active trong DB
  riskPerTradePct?: number; // >0 => sizing theo rủi ro: mỗi lệnh rủi ro % (số dư/vốn) tại SL (1R)
  riskCompound?: boolean; // true (mặc định) = rủi ro theo số dư (lãi kép); false = theo vốn ban đầu
  maxPortfolioRiskPct?: number; // trần tổng rủi ro các vị thế mở đồng thời (% vốn). 0 = không giới hạn
  feePct?: number; // phí mỗi chiều (% notional). round-trip = 2×
  slippagePct?: number; // trượt giá mỗi chiều (% notional). round-trip = 2×
  fundingRatePctPer8h?: number; // funding perp ước lượng mỗi 8h (% notional). Mặc định 0.01%
  useRealFunding?: boolean; // true = nạp funding LỊCH SỬ thật từ Binance (cache đĩa) thay cho ước lượng
  maintenanceMarginRatePct?: number; // tỷ lệ maintenance margin (% notional) cho giá thanh lý ISOLATED. Mặc định 0.5
  useLiquidation?: boolean; // true (mặc định) = mô hình thanh lý: vị thế bị thanh lý khi giá đi ngược ≥ (100/đòn_bẩy − mmr)%
  compounding?: boolean; // true = lãi kép theo equity hiện tại; false (mặc định) = sizing cố định theo vốn ban đầu
  monthlyReset?: boolean; // DEPRECATED alias của (compounding=false). monthlyReset=true ⇒ compounding=false. Dùng `compounding`.
  // ----- Circuit breaker theo drawdown danh mục (0 = tắt) -----
  ddReducePct?: number; // DD ≥ % này -> giảm size lệnh mới
  ddReduceFactor?: number; // hệ số giảm size (mặc định 0.5)
  ddHaltPct?: number; // DD ≥ % này -> ngừng mở lệnh mới (latch)
  ddResumePct?: number; // DD hồi ≤ % này -> mở lại
  dailyLossLimitPct?: number; // giới hạn lỗ NGÀY (% vốn) -> ngừng mở tới hết ngày (0 = tắt)
  weeklyLossLimitPct?: number; // giới hạn lỗ TUẦN (% vốn) (0 = tắt)
  // ----- Correlation cluster cap -----
  maxPerCluster?: number; // trần vị thế mở đồng thời TRONG 1 cụm tương quan (0 = tắt)
  corrThreshold?: number; // ngưỡng tương quan gom cụm (mặc định 0.8)
  useCorrelationCap?: boolean; // bật gom cụm tương quan + áp trần
}

export interface BacktestTrade {
  symbol: string;
  entryTime: number;
  entryPrice: number;
  exitTime: number;
  exitPrice: number;
  pnlPct: number; // % biến động giá (đã gộp các lần chốt từng phần)
  pnlUsdt: number; // lãi/lỗ quy ra USDT
  // TRAIL = chandelier trailing; DONCHIAN = thủng kênh dcExit; TIME = time-stop; EOD = hết dữ liệu. [H4]
  reason: "TP" | "SL" | "LIQ" | "EOD" | "TRAIL" | "FLIP" | "DONCHIAN" | "TIME";
  barsHeld: number;
  probability: number;
  riskPctPrice?: number; // R = |entry - SL| tính theo % giá (cho R-based sizing)
  side?: "LONG" | "SHORT"; // chiều vị thế (mặc định LONG) — dùng cho dấu funding
  maePct?: number; // Max Adverse Excursion: % lãi/lỗ TỆ NHẤT trong lúc giữ lệnh (≤ 0)
  maeTime?: number; // thời điểm chạm MAE (epoch ms) — để dựng đường unrealized theo timeline
  mfePct?: number; // Max Favorable Excursion: % lãi/lỗ THUẬN LỢI NHẤT trong lúc giữ lệnh (≥ 0)
  mfeTime?: number; // thời điểm chạm MFE (epoch ms) — để dựng đường unrealized (đỉnh giữa lệnh)
  fundingPct?: number; // funding thực tế của lệnh (% notional) nếu đã nạp từ lịch sử; else undefined
  state?: string; // EMA: state lúc vào lệnh (LONG1..SHORT1)
  alignment?: string; // EMA: alignment (MOMENTUM/PULLBACK/REVERSAL) = nhóm chiến thuật TP/SL
  cluster?: number; // id cụm tương quan (correlation cap) — gán trước khi áp trần
  notTaken?: boolean; // engine danh mục BỎ mở (DD circuit breaker / hết tiền) -> loại khỏi thống kê
}

export interface SymbolResult {
  symbol: string;
  candles: number;
  trades: number;
  wins: number;
  returnPct: number;
}

export interface MonthlyStat {
  month: string; // "YYYY-MM" (UTC, theo thời gian VÀO lệnh)
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  returnPct: number; // tổng % biến động giá
  pnlUsdt: number; // tổng lãi/lỗ USDT
  avgReturnPct: number;
}

export interface DailyStat {
  day: string; // "YYYY-MM-DD" (UTC, theo thời gian VÀO lệnh)
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  returnPct: number;
  pnlUsdt: number;
  avgReturnPct: number;
  grossWin: number; // Σ %pnl các lệnh THẮNG (cho PF theo kỳ)
  grossLoss: number; // Σ |%pnl| các lệnh THUA
}

/** 1 lệnh trong chuỗi kéo tài khoản về 0 (theo thứ tự ĐÓNG lệnh) */
export interface BlowupTrade {
  seq: number; // thứ tự đóng lệnh (1-based)
  symbol: string;
  state?: string;
  entryTime: number;
  exitTime: number;
  entryPrice: number;
  exitPrice: number;
  reason: string;
  pnlPct: number;
  pnlUsdt: number;
  balanceBefore: number;
  balanceAfter: number;
}

/** Thống kê gộp theo 1 khóa (kiểu thoát, state, alignment...) */
export interface GroupStat {
  key: string;
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  returnPct: number;
  pnlUsdt: number;
  avgReturnPct: number;
}

export interface BacktestResult {
  params: Required<Pick<BacktestParams, "months" | "interval" | "takeProfitPct" | "stopLossPct">> & {
    minDropPct: number;
    minSidewayCandles: number;
    maxSidewayRangePct: number;
    minRisePct: number;
  };
  from: string;
  to: string;
  symbolsTested: string[];
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  totalReturnPct: number;
  avgReturnPct: number;
  maxWinPct: number;
  maxLossPct: number;
  maxDrawdownPct: number; // % drawdown chuẩn hóa theo peak equity (0..100)
  profitFactor: number; // tổng lãi% / tổng lỗ% (gross). 999 = không có lệnh lỗ (∞)
  profitFactorUsdt: number; // PF theo TIỀN (Σ lãi USDT / |Σ lỗ USDT|). 999 = không có lệnh lỗ (∞)
  avgWinUsdt: number; // lãi trung bình mỗi lệnh THẮNG (USDT)
  avgLossUsdt: number; // lỗ trung bình mỗi lệnh THUA (USDT, ≤ 0)
  expectancyUsdt: number; // kỳ vọng mỗi lệnh theo TIỀN = mean(pnlUsdt)
  sharpe: number | null; // Sharpe annualized theo return NGÀY của equity curve. null = std = 0 (không xác định)
  sortino: number | null; // Sortino annualized (downside deviation). null = downside dev = 0
  calmar: number | null; // CAGR / MaxDrawdown. null = MaxDD = 0
  cagr: number; // tăng trưởng kép hằng năm (%)
  expectancyR: number; // kỳ vọng theo bội số R mỗi lệnh
  maxConsecutiveWins: number;
  maxConsecutiveLosses: number;
  avgHoldingHours: number; // thời gian giữ lệnh trung bình (giờ thực)
  avgBarsHeld: number;
  equityCurve: number[]; // % cộng dồn
  equityDailyUsdt: number[]; // equity (balance + unrealized) lấy mẫu theo NGÀY
  // ----- Theo tiền (USDT) -----
  initialCapitalUsdt: number;
  orderSizeUsdt: number;
  leverage: number;
  totalPnlUsdt: number;
  finalBalanceUsdt: number;
  roiPct: number; // lợi nhuận trên vốn ban đầu
  maxDrawdownUsdt: number;
  equityCurveUsdt: number[]; // số dư USDT sau mỗi lệnh
  // ----- Ràng buộc danh mục -----
  maxConcurrentPositions: number; // trần vị thế mở đồng thời (0 = không giới hạn)
  candidateTrades: number; // tổng tín hiệu trước khi áp trần
  skippedByCap: number; // số tín hiệu bị bỏ vì chạm trần (đồng thời/cluster)
  skippedByRisk: number; // số lệnh bị bỏ MỞ bởi circuit breaker DD / hết tiền
  peakConcurrent: number; // số vị thế mở đồng thời cao nhất thực tế
  marginMode: "CROSS" | "ISOLATED";
  tpSlMode: "PRICE" | "MARGIN";
  liquidations: number; // số lệnh bị thanh lý (chỉ ISOLATED)
  liqPriceMovePct: number; // % giảm giá gây thanh lý (≈ -100/đòn bẩy)
  accountBlown: boolean; // tài khoản cháy (mất sạch vốn)
  blownAtTrade: number; // cháy ở lệnh thứ mấy (0 = không cháy)
  blownAt: number; // thời điểm (epoch ms) equity chạm ≤ 0 lần đầu (0 = không cháy)
  blowupTrades: BlowupTrade[]; // chuỗi lệnh (theo thứ tự đóng) kéo tài khoản về 0
  byMonth: MonthlyStat[]; // thống kê theo từng tháng (theo thời gian vào lệnh)
  byDay: DailyStat[]; // thống kê theo từng NGÀY (theo thời gian vào lệnh)
  byReason: GroupStat[]; // theo KIỂU THOÁT (TP/SL/TRAIL/FLIP/EOD) — từng cách cắt TP/SL
  byState: GroupStat[]; // theo STATE EMA (rỗng nếu không phải backtest EMA)
  byAlignment: GroupStat[]; // theo nhóm chiến thuật (MOMENTUM/PULLBACK/REVERSAL)
  trades: BacktestTrade[];
  perSymbol: SymbolResult[];
}

/** Khoá tháng "YYYY-MM" theo UTC từ epoch ms */
function monthKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** Khoá ngày "YYYY-MM-DD" theo UTC từ epoch ms */
function dayKey(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

/** Gộp lệnh theo NGÀY vào lệnh (mirror aggregateByMonth). */
function aggregateByDay(trades: BacktestTrade[]): DailyStat[] {
  const map = new Map<string, DailyStat>();
  for (const t of trades) {
    const key = dayKey(t.entryTime);
    let d = map.get(key);
    if (!d) {
      d = { day: key, trades: 0, wins: 0, losses: 0, winRate: 0, returnPct: 0, pnlUsdt: 0, avgReturnPct: 0, grossWin: 0, grossLoss: 0 };
      map.set(key, d);
    }
    d.trades += 1;
    if (t.pnlPct > 0) { d.wins += 1; d.grossWin += t.pnlPct; }
    else { d.losses += 1; d.grossLoss += -t.pnlPct; }
    d.returnPct += t.pnlPct;
    d.pnlUsdt += t.pnlUsdt;
  }
  return [...map.values()]
    .sort((a, b) => a.day.localeCompare(b.day))
    .map((d) => ({
      ...d,
      winRate: d.trades ? Number(((d.wins / d.trades) * 100).toFixed(1)) : 0,
      avgReturnPct: d.trades ? Number((d.returnPct / d.trades).toFixed(2)) : 0,
      returnPct: Number(d.returnPct.toFixed(2)),
      pnlUsdt: Number(d.pnlUsdt.toFixed(2)),
      grossWin: Number(d.grossWin.toFixed(2)),
      grossLoss: Number(d.grossLoss.toFixed(2)),
    }));
}

/** Gộp lệnh theo một khóa bất kỳ (kiểu thoát/state/alignment); bỏ qua lệnh không có khóa. */
function aggregateBy(
  trades: BacktestTrade[],
  keyOf: (t: BacktestTrade) => string | undefined
): GroupStat[] {
  const map = new Map<string, GroupStat>();
  for (const t of trades) {
    const key = keyOf(t);
    if (!key) continue;
    let g = map.get(key);
    if (!g) {
      g = { key, trades: 0, wins: 0, losses: 0, winRate: 0, returnPct: 0, pnlUsdt: 0, avgReturnPct: 0 };
      map.set(key, g);
    }
    g.trades += 1;
    if (t.pnlPct > 0) g.wins += 1;
    else g.losses += 1;
    g.returnPct += t.pnlPct;
    g.pnlUsdt += t.pnlUsdt;
  }
  return [...map.values()]
    .sort((a, b) => b.trades - a.trades)
    .map((g) => ({
      ...g,
      winRate: g.trades ? Number(((g.wins / g.trades) * 100).toFixed(1)) : 0,
      avgReturnPct: g.trades ? Number((g.returnPct / g.trades).toFixed(2)) : 0,
      returnPct: Number(g.returnPct.toFixed(2)),
      pnlUsdt: Number(g.pnlUsdt.toFixed(2)),
    }));
}

/** Gộp danh sách lệnh theo tháng (theo thời gian VÀO lệnh) */
function aggregateByMonth(trades: BacktestTrade[]): MonthlyStat[] {
  const map = new Map<string, MonthlyStat>();
  for (const t of trades) {
    const key = monthKey(t.entryTime);
    let m = map.get(key);
    if (!m) {
      m = { month: key, trades: 0, wins: 0, losses: 0, winRate: 0, returnPct: 0, pnlUsdt: 0, avgReturnPct: 0 };
      map.set(key, m);
    }
    m.trades += 1;
    if (t.pnlPct > 0) m.wins += 1;
    else m.losses += 1;
    m.returnPct += t.pnlPct;
    m.pnlUsdt += t.pnlUsdt;
  }
  return [...map.values()]
    .sort((a, b) => a.month.localeCompare(b.month))
    .map((m) => ({
      ...m,
      winRate: m.trades ? Number(((m.wins / m.trades) * 100).toFixed(1)) : 0,
      avgReturnPct: m.trades ? Number((m.returnPct / m.trades).toFixed(2)) : 0,
      returnPct: Number(m.returnPct.toFixed(2)),
      pnlUsdt: Number(m.pnlUsdt.toFixed(2)),
    }));
}

const FIFTEEN_MIN = 15 * 60 * 1000;

/** Mô phỏng toàn bộ trade cho 1 symbol (export cho unit test) */
export function simulateSymbol(
  symbol: string,
  klines: Kline[],
  tpPct: number,
  slPct: number,
  sp: StrategyParams,
  leverage: number,
  marginMode: "CROSS" | "ISOLATED",
  tpSlMode: "PRICE" | "MARGIN",
  mmr: number // maintenance margin rate (% notional) cho giá thanh lý ISOLATED
): BacktestTrade[] {
  const trades: BacktestTrade[] = [];
  const minNeeded = (sp.minSidewayCandles ?? 20) + 5;
  let i = minNeeded;

  // MARGIN: TP/SL là % trên ký quỹ (ROI) -> %giá = TP%/đòn bẩy.
  // PRICE: TP/SL là % biến động giá trực tiếp.
  const tpMovePct = tpSlMode === "MARGIN" ? tpPct / leverage : tpPct;
  const slMovePct = tpSlMode === "MARGIN" ? slPct / leverage : slPct;

  while (i < klines.length) {
    const slice = klines.slice(0, i + 1);
    const p = detectLongPattern(slice, sp);
    if (!p.matched) {
      i++;
      continue;
    }

    const entry = p.entryPrice; // = close nến breakout (klines[i].close)
    const tp = entry * (1 + tpMovePct / 100);
    const sl = entry * (1 - slMovePct / 100);
    // Giá thanh lý ISOLATED (có maintenance margin): mất ký quỹ khi lỗ ≈ (1/đòn bẩy − mmr).
    // liq = entry × (1 − 1/đòn bẩy + mmr/100). mmr>0 kéo liq LẠI GẦN entry hơn -> cháy sớm hơn (bi quan).
    const liq = entry * (1 - 1 / leverage + mmr / 100);

    // Trên đà giảm, mức giá CAO hơn (gần entry hơn) bị chạm trước.
    // ISOLATED + giá thanh lý nằm trên SL => bị cháy trước khi tới SL.
    const useLiq = marginMode === "ISOLATED" && liq > sl;
    const downPrice = useLiq ? liq : sl;
    const downReason: BacktestTrade["reason"] = useLiq ? "LIQ" : "SL";

    let exitIdx = -1;
    let exitPrice = 0;
    let reason: BacktestTrade["reason"] = "EOD";
    let worstLow = entry; // MAE: giá thấp nhất chạm trong lúc giữ (LONG -> adverse = giảm)
    let worstTime = klines[i].openTime;
    let bestHigh = entry; // MFE: giá cao nhất chạm trong lúc giữ (LONG -> favorable = tăng)
    let bestTime = klines[i].openTime;

    for (let j = i + 1; j < klines.length; j++) {
      const c = klines[j];
      // Cập nhật MAE/MFE trước (kể cả nến thoát) -> bắt được đáy sâu & đỉnh cao nhất trong lúc giữ.
      if (c.low < worstLow) {
        worstLow = c.low;
        worstTime = c.openTime;
      }
      if (c.high > bestHigh) {
        bestHigh = c.high;
        bestTime = c.openTime;
      }
      const hitDown = c.low <= downPrice;
      const hitTP = c.high >= tp;
      // Trong cùng 1 nến nếu chạm cả hai -> giả định downside trước (bi quan).
      if (hitDown) {
        exitIdx = j;
        // Gap: nếu nến MỞ đã vượt qua mức chặn -> fill tại open (tệ hơn mức chặn).
        exitPrice = c.open < downPrice ? c.open : downPrice;
        reason = downReason;
        break;
      }
      // TP là lệnh limit: dù open gap thuận lợi vượt TP, vẫn fill tại tp (không lấy bonus).
      if (hitTP) {
        exitIdx = j;
        exitPrice = tp;
        reason = "TP";
        break;
      }
    }

    if (exitIdx === -1) {
      exitIdx = klines.length - 1;
      exitPrice = klines[exitIdx].close;
      reason = "EOD";
    }

    const pnlPct = ((exitPrice - entry) / entry) * 100;
    const maePct = Math.min(0, ((worstLow - entry) / entry) * 100);
    const mfePct = Math.max(0, ((bestHigh - entry) / entry) * 100);
    // R = khoảng cách entry→mức chặn thực tế theo % giá. Nếu LIQ chặn trước SL -> tới liq (không dùng slMovePct).
    const riskPctPrice = ((entry - downPrice) / entry) * 100;
    trades.push({
      symbol,
      side: "LONG",
      maePct,
      maeTime: worstTime,
      mfePct,
      mfeTime: bestTime,
      entryTime: klines[i].openTime,
      entryPrice: entry,
      exitTime: klines[exitIdx].openTime,
      exitPrice,
      pnlPct,
      pnlUsdt: 0, // tính sau khi biết orderSize/leverage
      reason,
      barsHeld: exitIdx - i,
      probability: p.probability,
      riskPctPrice,
    });

    i = exitIdx + 1; // không chồng lệnh
  }

  return trades;
}

/** Lấy danh sách symbol mặc định: top theo volume từ market_data, fallback list */
async function defaultSymbols(limit: number): Promise<string[]> {
  const rows = await prisma.marketData.findMany({
    orderBy: { createdAt: "desc" },
    take: 1500,
  });
  const seen = new Map<string, number>();
  for (const r of rows) {
    if (!seen.has(r.symbol)) seen.set(r.symbol, r.quoteVolume);
  }
  const sorted = [...seen.entries()].sort((a, b) => b[1] - a[1]).map((x) => x[0]);
  if (sorted.length) return sorted.slice(0, limit);
  return ["BTCUSDT", "ETHUSDT", "BNBUSDT", "SOLUSDT", "XRPUSDT"].slice(0, limit);
}

/** Xác định mốc thời gian backtest: ưu tiên fromMs/toMs, nếu không thì N tháng gần nhất */
function resolveRange(params: BacktestParams): { startTime: number; endTime: number } {
  if (params.fromMs && params.toMs && params.toMs > params.fromMs) {
    return { startTime: params.fromMs, endTime: params.toMs };
  }
  const months = params.months ?? 3;
  const endTime = Date.now();
  return { startTime: endTime - months * 30 * 24 * 60 * 60 * 1000, endTime };
}

export async function runBacktest(params: BacktestParams = {}): Promise<BacktestResult> {
  const months = params.months ?? 3;
  const interval = params.interval ?? "15m";
  const tpPct = params.takeProfitPct ?? 30;
  const slPct = params.stopLossPct ?? 15;
  const maxSymbols = Math.min(params.maxSymbols ?? 8, 30);

  const sp: StrategyParams = {
    minDropPct: params.minDropPct ?? 15,
    minSidewayCandles: params.minSidewayCandles ?? 20,
    maxSidewayRangePct: params.maxSidewayRangePct ?? 5,
    minRisePct: params.minRisePct ?? 10,
  };

  const symbols =
    params.symbols && params.symbols.length
      ? params.symbols.map((s) => s.toUpperCase()).slice(0, maxSymbols)
      : await defaultSymbols(maxSymbols);

  const { startTime, endTime } = resolveRange(params);

  logger.info("strategy", `Backtest ${symbols.length} symbol, ${months} tháng, ${interval}`, {
    symbols,
  });

  const allTrades: BacktestTrade[] = [];
  const perSymbol: SymbolResult[] = [];

  const leverage = params.leverage ?? 1;
  const marginMode = params.marginMode ?? "CROSS";
  const tpSlMode = params.tpSlMode ?? "PRICE";
  const mmr = params.maintenanceMarginRatePct ?? 0.5;
  for (const symbol of symbols) {
    await simulateOneSymbol(
      symbol, interval, startTime, endTime, tpPct, slPct, sp, leverage, marginMode, tpSlMode, mmr, allTrades, perSymbol
    );
  }

  return buildResult(allTrades, perSymbol, {
    params,
    sp,
    months,
    interval,
    tpPct,
    slPct,
    startTime,
    endTime,
    symbols,
  });
}

/** Tải klines + mô phỏng 1 symbol, ghi vào allTrades/perSymbol (dùng chung) */
async function simulateOneSymbol(
  symbol: string,
  interval: string,
  startTime: number,
  endTime: number,
  tpPct: number,
  slPct: number,
  sp: StrategyParams,
  leverage: number,
  marginMode: "CROSS" | "ISOLATED",
  tpSlMode: "PRICE" | "MARGIN",
  mmr: number,
  allTrades: BacktestTrade[],
  perSymbol: SymbolResult[]
): Promise<void> {
  try {
    const klines = await binance.getKlinesRange(symbol, interval, startTime, endTime);
    if (klines.length < 60) {
      perSymbol.push({ symbol, candles: klines.length, trades: 0, wins: 0, returnPct: 0 });
      return;
    }
    const trades = simulateSymbol(symbol, klines, tpPct, slPct, sp, leverage, marginMode, tpSlMode, mmr);
    const wins = trades.filter((t) => t.pnlPct > 0).length;
    const returnPct = trades.reduce((s, t) => s + t.pnlPct, 0);
    perSymbol.push({ symbol, candles: klines.length, trades: trades.length, wins, returnPct });
    allTrades.push(...trades);
  } catch (err) {
    logger.warn("strategy", `Backtest ${symbol} lỗi: ${String(err)}`);
    perSymbol.push({ symbol, candles: 0, trades: 0, wins: 0, returnPct: 0 });
  }
}

/**
 * Áp trần vị thế mở đồng thời trên TOÀN DANH MỤC.
 * Duyệt tín hiệu theo thời gian vào lệnh; chỉ nhận lệnh khi số vị thế đang mở
 * (exitTime > entryTime của lệnh đang xét) < maxConcurrent, ngược lại bỏ qua.
 */
function applyConcurrencyCap(
  candidates: BacktestTrade[],
  maxConcurrent: number,
  clusterOf?: Map<string, number>,
  maxPerCluster?: number
): { accepted: BacktestTrade[]; skipped: number; peak: number } {
  const useCluster = !!clusterOf && !!maxPerCluster && maxPerCluster > 0;
  if ((!maxConcurrent || maxConcurrent <= 0) && !useCluster) {
    return { accepted: candidates, skipped: 0, peak: candidates.length ? 1 : 0 };
  }
  // Sắp xếp TẤT ĐỊNH: entryTime ↑, rồi symbol, rồi entryPrice -> nhận/bỏ lệnh tái lập 100%.
  const sorted = [...candidates].sort(
    (a, b) =>
      a.entryTime - b.entryTime ||
      a.symbol.localeCompare(b.symbol) ||
      a.entryPrice - b.entryPrice
  );
  const accepted: BacktestTrade[] = [];
  let openExits: number[] = [];
  const clusterExits = new Map<number, number[]>(); // clusterId -> exitTimes đang mở
  let skipped = 0;
  let peak = 0;
  const noGlobal = !maxConcurrent || maxConcurrent <= 0;
  for (const c of sorted) {
    openExits = openExits.filter((e) => e > c.entryTime);
    const globalOk = noGlobal || openExits.length < maxConcurrent;
    let clusterOk = true;
    let cid = -1;
    if (useCluster) {
      cid = clusterOf!.get(c.symbol) ?? -1;
      const arr = (clusterExits.get(cid) ?? []).filter((e) => e > c.entryTime);
      clusterExits.set(cid, arr);
      clusterOk = arr.length < maxPerCluster!;
    }
    if (globalOk && clusterOk) {
      accepted.push(c);
      openExits.push(c.exitTime);
      if (useCluster) clusterExits.get(cid)!.push(c.exitTime);
      peak = Math.max(peak, openExits.length);
    } else {
      skipped += 1;
    }
  }
  return { accepted, skipped, peak };
}

interface BuildCtx {
  params: BacktestParams;
  sp: StrategyParams;
  months: number;
  interval: string;
  tpPct: number;
  slPct: number;
  startTime: number;
  endTime: number;
  symbols: string[];
  clusterOf?: Map<string, number>; // symbol -> cluster id (correlation cap)
  maxPerCluster?: number; // trần vị thế/cụm (0 = tắt)
}

interface PortfolioOpts {
  initialCapital: number;
  orderSize: number;
  positionSizePct: number;
  leverage: number;
  riskPerTradePct: number;
  riskCompound: boolean;
  compounding: boolean; // true = size theo equity hiện tại (lãi kép); false = theo vốn ban đầu
  startTime: number;
  endTime: number;
  // ----- Circuit breaker theo drawdown danh mục (0/disabled mặc định) -----
  ddReducePct?: number; // DD ≥ % này -> giảm size lệnh mới theo ddReduceFactor
  ddReduceFactor?: number; // hệ số giảm size khi ở vùng ddReduce (mặc định 0.5)
  ddHaltPct?: number; // DD ≥ % này -> NGỪNG mở lệnh mới (latch)
  ddResumePct?: number; // DD hồi về ≤ % này -> mở lại
  // ----- Giới hạn lỗ theo NGÀY/TUẦN (0 = tắt). Chặn mở lệnh mới khi lỗ realized trong kỳ ≥ ngưỡng. -----
  dailyLossLimitPct?: number; // % vốn ban đầu; lỗ realized trong NGÀY ≥ % này -> ngừng mở tới hết ngày
  weeklyLossLimitPct?: number; // tương tự theo TUẦN
}

interface PortfolioResult {
  equityCurveUsdt: number[]; // equity sau mỗi lần ĐÓNG lệnh (theo thứ tự đóng) — cho sparkline/blowup
  equityDailyUsdt: number[]; // equity (= cash + margin + unrealized) lấy mẫu theo NGÀY
  dailyReturns: number[]; // return ngày (equity[d]/equity[d-1]-1)
  maxDrawdownUsdt: number; // âm (USDT), đỉnh->đáy trên equity NGÀY
  maxDrawdownPct: number; // 0..100, chuẩn hóa theo peak
  totalPnlUsdt: number;
  finalBalanceUsdt: number;
  roiPct: number;
  cagr: number; // %/năm (−100 nếu tài khoản cháy / finalEq ≤ 0)
  sharpe: number | null; // null = std = 0
  sortino: number | null; // null = downside deviation = 0
  calmar: number | null; // null = MaxDD = 0
  profitFactorUsdt: number; // Σ lãi USDT / |Σ lỗ USDT| (999 = không có lệnh lỗ)
  avgWinUsdt: number;
  avgLossUsdt: number;
  expectancyUsdt: number; // mean(pnlUsdt)
  accountBlown: boolean;
  blownAtTrade: number; // theo thứ tự ĐÓNG lệnh (1-based)
  blownAt: number; // epoch ms equity ≤ 0 lần đầu (0 = không cháy)
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Engine danh mục EVENT-DRIVEN (chuẩn quỹ):
 *  - Size + KHÓA margin tại lúc VÀO lệnh (không cho tổng margin vượt cash).
 *  - Realize PnL + trả margin tại lúc ĐÓNG lệnh.
 *  - Equity = cash + Σ(margin + unrealized) — unrealized nội suy tuyến tính theo thời gian giữ lệnh.
 *  - Drawdown lấy trên equity NGÀY, chuẩn hóa theo peak (không bao giờ > 100%).
 *  - Cháy tài khoản (equity ≤ 0): dừng MỞ lệnh mới.
 * Ghi t.pnlUsdt cho từng trade (theo margin đã khóa).
 */
export function simulatePortfolio(trades: BacktestTrade[], opts: PortfolioOpts): PortfolioResult {
  const {
    initialCapital, orderSize, positionSizePct, leverage,
    riskPerTradePct, riskCompound, compounding, startTime, endTime,
  } = opts;
  const useRisk = riskPerTradePct > 0;
  // Circuit breaker DD (tắt nếu ngưỡng = 0)
  const ddHaltPct = opts.ddHaltPct ?? 0;
  const ddResumePct = opts.ddResumePct ?? 0;
  const ddReducePct = opts.ddReducePct ?? 0;
  const ddReduceFactor = opts.ddReduceFactor ?? 0.5;
  let ddHalted = false; // latch: đang ngừng mở lệnh vì DD quá sâu
  // Giới hạn lỗ ngày/tuần (0 = tắt). Cộng dồn PnL realized theo kỳ, chặn mở lệnh khi lỗ ≥ ngưỡng.
  const dailyLossLimit = opts.dailyLossLimitPct ?? 0;
  const weeklyLossLimit = opts.weeklyLossLimitPct ?? 0;
  const dayPnl = new Map<number, number>();  // dayIndex -> realized PnL USDT
  const weekPnl = new Map<number, number>(); // weekIndex -> realized PnL USDT
  const dayIdx = (t: number) => Math.floor(t / DAY_MS);
  const weekIdx = (t: number) => Math.floor((t - 4 * DAY_MS) / (7 * DAY_MS)); // mốc thứ 2 (epoch 1970-01-01 là thứ 5)
  const addPeriodPnl = (t: number, pnl: number) => {
    dayPnl.set(dayIdx(t), (dayPnl.get(dayIdx(t)) ?? 0) + pnl);
    weekPnl.set(weekIdx(t), (weekPnl.get(weekIdx(t)) ?? 0) + pnl);
  };

  type OpenPos = { tr: BacktestTrade; margin: number; usdtPerPct: number };
  type Ev = { t: number; kind: 0 | 1; tr: BacktestTrade }; // 0 = mở, 1 = đóng
  const evs: Ev[] = [];
  for (const tr of trades) {
    evs.push({ t: tr.entryTime, kind: 0, tr });
    evs.push({ t: tr.exitTime, kind: 1, tr });
  }
  // Sắp xếp TẤT ĐỊNH (tie-break ổn định): thời gian ↑, ĐÓNG (kind=1) trước MỞ (kind=0) để
  // giải phóng margin, rồi symbol, rồi entryPrice -> kết quả tái lập 100% qua các lần chạy.
  evs.sort(
    (a, b) =>
      a.t - b.t ||
      b.kind - a.kind ||
      a.tr.symbol.localeCompare(b.tr.symbol) ||
      a.tr.entryPrice - b.tr.entryPrice
  );

  let cash = initialCapital;
  const open = new Map<BacktestTrade, OpenPos>();
  const equityCurveUsdt: number[] = [];
  let accountBlown = false;
  let blownAtTrade = 0;
  let blownAt = 0; // epoch ms equity ≤ 0 lần đầu (0 = không cháy)
  let closedCount = 0;

  // ----- Chỉ số theo TIỀN (chỉ tính trên lệnh THỰC SỰ mở & đóng, gồm cả force-close khi cháy) -----
  let gpU = 0; // Σ lãi USDT
  let glU = 0; // Σ |lỗ| USDT
  let winU = 0, winN = 0, lossU = 0, lossN = 0, sumU = 0, realizedN = 0;
  const recordMoney = (pnl: number) => {
    sumU += pnl; realizedN++;
    if (pnl >= 0) { gpU += pnl; winU += pnl; winN++; }
    else { glU += -pnl; lossU += pnl; lossN++; }
  };

  // Đường %lãi/lỗ của 1 lệnh theo timeline: GẤP KHÚC qua CẢ MAE (đáy) và MFE (đỉnh) theo đúng
  // thứ tự thời gian: entry(0) → [MAE, MFE sắp theo time] → exit(pnlPct), nội suy tuyến tính từng đoạn.
  // Có MFE -> equity tạo đỉnh giữa lệnh -> peak không bị thấp giả -> Max DD không bị đánh giá thấp.
  const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
  const pctPathAt = (tr: BacktestTrade, tau: number): number => {
    const e = tr.entryTime;
    const x = tr.exitTime;
    const fin = tr.pnlPct;
    if (x <= e) return fin;
    // Điểm giữa hợp lệ trong (e, x): MAE (âm) và MFE (dương). Bỏ qua điểm không hợp lệ.
    const mids: { t: number; v: number }[] = [];
    if (tr.maePct !== undefined && tr.maePct < 0 && tr.maeTime !== undefined && tr.maeTime > e && tr.maeTime < x)
      mids.push({ t: tr.maeTime, v: tr.maePct });
    if (tr.mfePct !== undefined && tr.mfePct > 0 && tr.mfeTime !== undefined && tr.mfeTime > e && tr.mfeTime < x)
      mids.push({ t: tr.mfeTime, v: tr.mfePct });
    mids.sort((a, b) => a.t - b.t);
    const nodes = [{ t: e, v: 0 }, ...mids, { t: x, v: fin }];
    for (let k = 0; k < nodes.length - 1; k++) {
      const a = nodes[k];
      const b = nodes[k + 1];
      if (tau <= b.t) {
        if (b.t <= a.t) return a.v; // hai mốc trùng thời điểm
        return a.v + (b.v - a.v) * clamp01((tau - a.t) / (b.t - a.t));
      }
    }
    return fin;
  };
  // Unrealized USDT tại thời điểm τ = usdtPerPct × %lãi lỗ trên đường timeline.
  const unreal = (p: OpenPos, tau: number): number => p.usdtPerPct * pctPathAt(p.tr, tau);
  const equityAt = (tau: number): number => {
    let eq = cash;
    for (const p of open.values()) eq += p.margin + unreal(p, tau);
    return eq;
  };

  // ----- Drawdown trên TIMELINE SỰ KIỆN (mọi đỉnh gấp khúc). Vì equity piecewise-linear, cực trị
  //       luôn nằm tại đỉnh gấp khúc -> cách này CHÍNH XÁC TUYỆT ĐỐI cho mô hình nội suy. -----
  let peak = initialCapital;
  let maxDDUsdt = 0; // ≤ 0
  let maxDDPct = 0; // 0..1
  const trackDD = (eq: number) => {
    if (eq > peak) peak = eq;
    const ddU = eq - peak;
    if (ddU < maxDDUsdt) maxDDUsdt = ddU;
    const ddP = peak > 0 ? (peak - eq) / peak : 0;
    if (ddP > maxDDPct) maxDDPct = ddP;
  };

  // Force-close toàn bộ vị thế đang mở tại pct nội suy hiện hành (dùng khi cháy CROSS).
  const forceCloseAll = (tau: number) => {
    for (const p of open.values()) {
      const pnl = p.usdtPerPct * pctPathAt(p.tr, tau);
      p.tr.pnlUsdt = Number(pnl.toFixed(2));
      recordMoney(pnl);
      closedCount++;
      equityCurveUsdt.push(0); // sau khi cháy, equity = 0
    }
    open.clear();
    cash = 0;
  };

  // Mọi đỉnh gấp khúc của đường equity: mốc mở/đóng + mọi maeTime/mfeTime của các vị thế.
  const probeSet = new Set<number>();
  for (const tr of trades) {
    probeSet.add(tr.entryTime);
    probeSet.add(tr.exitTime);
    if (tr.maeTime !== undefined) probeSet.add(tr.maeTime);
    if (tr.mfeTime !== undefined) probeSet.add(tr.mfeTime);
  }
  const probes = [...probeSet].sort((a, b) => a - b);
  let pi = 0;
  // Đánh giá equity tại các đỉnh gấp khúc ≤ upTo (equity liên tục qua sự kiện -> state trước
  // sự kiện tại cùng mốc là đủ). Cháy (equity ≤ 0) tại mốc ĐẦU TIÊN -> force-close, dừng vĩnh viễn.
  const runProbesUpTo = (upTo: number) => {
    while (pi < probes.length && probes[pi] <= upTo) {
      const tau = probes[pi++];
      if (accountBlown) { trackDD(0); continue; }
      const eq = equityAt(tau);
      if (eq <= 0) {
        trackDD(0); // equity sàn 0 -> DD 100% tại điểm cháy
        forceCloseAll(tau);
        accountBlown = true;
        blownAt = tau;
        blownAtTrade = closedCount;
      } else {
        trackDD(eq);
      }
    }
  };

  // Lưới ngày để lấy mẫu equity — CHỈ dùng cho Sharpe/Sortino/CAGR/daily returns (KHÔNG dùng cho DD).
  const equityDailyUsdt: number[] = [];
  let nextDay = startTime;
  const pushDaysUntil = (tau: number) => {
    while (nextDay <= tau && nextDay <= endTime) {
      equityDailyUsdt.push(Number((accountBlown ? 0 : equityAt(nextDay)).toFixed(2)));
      nextDay += DAY_MS;
    }
  };

  for (let evi = 0; evi < evs.length; evi++) {
    const ev = evs[evi];
    runProbesUpTo(ev.t); // đánh giá DD tại các đỉnh gấp khúc tới mốc này (state trước sự kiện)
    pushDaysUntil(ev.t); // lấy mẫu ngày TRƯỚC khi xử lý sự kiện tại mốc này

    if (ev.kind === 0) {
      // ----- MỞ lệnh: tính size, khóa margin -----
      if (accountBlown) { ev.tr.notTaken = true; ev.tr.pnlUsdt = 0; continue; } // cháy rồi -> không mở lệnh mới
      const equityNow = equityAt(ev.t);
      // ----- Circuit breaker theo drawdown danh mục -----
      // peak đã cập nhật tới ev.t qua runProbesUpTo ở đầu vòng lặp (entryTime là 1 probe).
      const curDDpct = peak > 0 ? ((peak - equityNow) / peak) * 100 : 0;
      if (ddHaltPct > 0) {
        if (!ddHalted && curDDpct >= ddHaltPct) ddHalted = true;
        else if (ddHalted && curDDpct <= ddResumePct) ddHalted = false;
      }
      if (ddHalted) { ev.tr.notTaken = true; ev.tr.pnlUsdt = 0; continue; } // DD quá sâu -> ngừng mở
      // Giới hạn lỗ ngày/tuần: nếu lỗ realized trong kỳ ≥ ngưỡng -> ngừng mở lệnh mới trong kỳ đó.
      if (dailyLossLimit > 0 && -(dayPnl.get(dayIdx(ev.t)) ?? 0) >= initialCapital * dailyLossLimit / 100) {
        ev.tr.notTaken = true; ev.tr.pnlUsdt = 0; continue;
      }
      if (weeklyLossLimit > 0 && -(weekPnl.get(weekIdx(ev.t)) ?? 0) >= initialCapital * weeklyLossLimit / 100) {
        ev.tr.notTaken = true; ev.tr.pnlUsdt = 0; continue;
      }
      // Giảm size khi ở vùng DD trung bình (chưa tới ngưỡng halt).
      const sizeScale = ddReducePct > 0 && curDDpct >= ddReducePct ? ddReduceFactor : 1;
      const basis = compounding ? Math.max(0, equityNow) : initialCapital;
      let margin: number;
      let usdtPerPct: number; // lãi/lỗ USDT trên mỗi 1% biến động giá
      if (useRisk) {
        const riskBase = riskCompound ? basis : initialCapital;
        const riskMoney = riskBase * (riskPerTradePct / 100) * sizeScale;
        const rPct = ev.tr.riskPctPrice && ev.tr.riskPctPrice > 0 ? ev.tr.riskPctPrice : 100;
        usdtPerPct = riskMoney / rPct; // pnl = riskMoney × (pnlPct/rPct) = usdtPerPct × pnlPct
        // Margin đúng nghĩa: notional sao cho lỗ tại SL = riskMoney -> notional = riskMoney/(R%/100).
        margin = riskMoney / (rPct / 100) / leverage;
      } else {
        margin = (positionSizePct > 0 ? basis * (positionSizePct / 100) : orderSize) * sizeScale;
        usdtPerPct = (margin * leverage) / 100;
      }
      // Khóa không quá cash khả dụng; hết tiền -> bỏ lệnh (không mở).
      if (cash <= 0 || margin <= 0) {
        ev.tr.notTaken = true;
        ev.tr.pnlUsdt = 0;
        continue;
      }
      if (margin > cash) {
        // clamp theo margin khả dụng -> co usdtPerPct theo cùng tỷ lệ
        usdtPerPct *= cash / margin;
        margin = cash;
      }
      cash -= margin;
      open.set(ev.tr, { tr: ev.tr, margin, usdtPerPct });
    } else {
      // ----- ĐÓNG lệnh: realize PnL, trả margin -----
      const p = open.get(ev.tr);
      if (!p) {
        // chưa từng mở (hết tiền / đã cháy) HOẶC đã bị force-close khi cháy -> giữ pnlUsdt đã gán.
        if (ev.tr.pnlUsdt === undefined) ev.tr.pnlUsdt = 0;
        continue;
      }
      // PnL thực tế = usdtPerPct × %lãi lỗ cuối (đã khóa tại entry, gồm cả co theo clamp margin).
      const pnl = p.usdtPerPct * ev.tr.pnlPct;
      ev.tr.pnlUsdt = Number(pnl.toFixed(2));
      recordMoney(pnl);
      addPeriodPnl(ev.t, pnl); // cộng vào PnL ngày/tuần cho giới hạn lỗ
      cash += p.margin + pnl;
      open.delete(ev.tr);
      closedCount++;
      const eqAfter = cash + [...open.values()].reduce((s, q) => s + q.margin + unreal(q, ev.t), 0);
      equityCurveUsdt.push(Number(eqAfter.toFixed(2)));
    }
  }
  runProbesUpTo(Infinity); // quét nốt các đỉnh gấp khúc còn lại
  pushDaysUntil(endTime); // lấy mẫu ngày nốt tới cuối kỳ

  // ----- Return ngày -> Sharpe/Sortino annualized (risk-free = 0) -----
  const dailyReturns: number[] = [];
  for (let d = 1; d < equityDailyUsdt.length; d++) {
    const prev = equityDailyUsdt[d - 1];
    if (prev > 0) dailyReturns.push(equityDailyUsdt[d] / prev - 1);
  }
  const n = dailyReturns.length;
  const mean = n ? dailyReturns.reduce((a, b) => a + b, 0) / n : 0;
  // Sharpe: SAMPLE std (÷ n−1), risk-free = 0. std = 0 (hoặc n < 2) -> null (không xác định).
  const variance = n > 1 ? dailyReturns.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1) : 0;
  const sd = Math.sqrt(variance);
  // Sortino: downside deviation trên TOÀN BỘ n return: sqrt(Σ min(ret,0)^2 / n). = 0 -> null.
  const dVar = n ? dailyReturns.reduce((a, r) => a + Math.min(r, 0) ** 2, 0) / n : 0;
  const dsd = Math.sqrt(dVar);
  const ANN = Math.sqrt(365);
  const sharpe: number | null = sd > 0 ? (mean / sd) * ANN : null;
  const sortino: number | null = dsd > 0 ? (mean / dsd) * ANN : null;

  const finalEquity = equityDailyUsdt.length ? equityDailyUsdt[equityDailyUsdt.length - 1] : initialCapital;
  const totalPnlUsdt = finalEquity - initialCapital;
  const roiPct = initialCapital > 0 ? (totalPnlUsdt / initialCapital) * 100 : 0;
  const years = (endTime - startTime) / (365 * DAY_MS);
  // CAGR: finalEq ≤ 0 (cháy) -> −100%. Guard years ≤ 0 / initial ≤ 0 -> 0.
  const cagr =
    years > 0 && initialCapital > 0
      ? finalEquity > 0
        ? (Math.pow(finalEquity / initialCapital, 1 / years) - 1) * 100
        : -100
      : 0;
  // Calmar: MaxDD = 0 -> null (không xác định).
  const calmar: number | null = maxDDPct > 0 ? cagr / (maxDDPct * 100) : null;

  const profitFactorUsdt = glU > 0 ? gpU / glU : gpU > 0 ? 999 : 0;
  const avgWinUsdt = winN ? winU / winN : 0;
  const avgLossUsdt = lossN ? lossU / lossN : 0; // ≤ 0
  const expectancyUsdt = realizedN ? sumU / realizedN : 0;

  return {
    equityCurveUsdt,
    equityDailyUsdt,
    dailyReturns,
    maxDrawdownUsdt: Number(maxDDUsdt.toFixed(2)),
    maxDrawdownPct: Number((maxDDPct * 100).toFixed(2)),
    totalPnlUsdt: Number(totalPnlUsdt.toFixed(2)),
    finalBalanceUsdt: Number(finalEquity.toFixed(2)),
    roiPct: Number(roiPct.toFixed(2)),
    cagr: Number(cagr.toFixed(2)),
    sharpe,
    sortino,
    calmar,
    profitFactorUsdt: Number(profitFactorUsdt.toFixed(2)),
    avgWinUsdt: Number(avgWinUsdt.toFixed(2)),
    avgLossUsdt: Number(avgLossUsdt.toFixed(2)),
    expectancyUsdt: Number(expectancyUsdt.toFixed(2)),
    accountBlown,
    blownAtTrade,
    blownAt,
  };
}

/** Tổng hợp toàn bộ thống kê (%/USDT) từ danh sách trade ứng viên + áp trần danh mục */
function buildResult(
  candidateTradesArr: BacktestTrade[],
  perSymbolInput: SymbolResult[],
  ctx: BuildCtx
): BacktestResult {
  const { params, sp, months, interval, tpPct, slPct, startTime, endTime, symbols } = ctx;

  // ----- Phí + trượt giá + funding: trừ thẳng vào % mỗi lệnh trước mọi tính toán -----
  // Phí/slippage: round-trip (vào + ra). Funding: ước lượng theo số mốc 8h giữ lệnh.
  // Tất cả là % trên NOTIONAL = % biến động giá, nên trừ trực tiếp vào pnlPct (đòn bẩy triệt tiêu).
  // Mặc định thực tế theo taker Binance USDT-M (0/0 cũ cho kết quả ẢO — bỏ qua chi phí giao dịch).
  const feePct = params.feePct ?? 0.045;
  const slippagePct = params.slippagePct ?? 0.02;
  const fundingRatePctPer8h = params.fundingRatePctPer8h ?? 0.01; // ~0.01%/8h mặc định (khi không có data thật)
  const costPct = 2 * (feePct + slippagePct); // round-trip (vào + ra)
  const EIGHT_H = 8 * 60 * 60 * 1000;
  // Số mốc funding (00:00/08:00/16:00 UTC, = bội số 8h của epoch) mà lệnh giữ QUA: (entry, exit].
  const fundingMarks = (entry: number, exit: number) =>
    exit > entry ? Math.floor(exit / EIGHT_H) - Math.floor(entry / EIGHT_H) : 0;
  if (costPct > 0 || fundingRatePctPer8h > 0) {
    for (const t of candidateTradesArr) {
      const sideSign = t.side === "SHORT" ? -1 : 1; // LONG trả funding khi rate>0; SHORT nhận
      // funding: dùng số THỰC (t.fundingPct = Σ rate lịch sử) nếu đã nạp; else ước lượng.
      const rawFundingPct =
        t.fundingPct !== undefined
          ? t.fundingPct
          : fundingMarks(t.entryTime, t.exitTime) * fundingRatePctPer8h;
      const fundingPct = rawFundingPct * sideSign;
      t.pnlPct = Number((t.pnlPct - costPct - fundingPct).toFixed(4));
    }
  }

  // ----- Trần vị thế đồng thời (kèm trần RỦI RO danh mục nếu dùng R-based) -----
  const riskPerTradePct = params.riskPerTradePct ?? 0;
  const useRiskSizing = riskPerTradePct > 0;
  let maxConcurrent = params.maxConcurrentPositions ?? 0;
  const portfolioRiskPct = params.maxPortfolioRiskPct ?? 0;
  if (useRiskSizing && portfolioRiskPct > 0 && riskPerTradePct > 0) {
    // tổng risk mở đồng thời ≤ portfolioRiskPct => số vị thế ≤ portfolioRiskPct / riskPerTradePct
    const byRisk = Math.max(1, Math.floor(portfolioRiskPct / riskPerTradePct));
    maxConcurrent = maxConcurrent > 0 ? Math.min(maxConcurrent, byRisk) : byRisk;
  }

  const { accepted, skipped, peak } = applyConcurrencyCap(
    candidateTradesArr,
    maxConcurrent,
    ctx.clusterOf,
    ctx.maxPerCluster
  );
  const allTrades = accepted.sort((a, b) => a.entryTime - b.entryTime);

  // ----- Tiền (USDT) — engine danh mục event-driven (khóa margin, unrealized, drawdown chuẩn) -----
  const initialCapitalUsdt = params.initialCapitalUsdt ?? 1000;
  const orderSizeUsdt = params.orderSizeUsdt ?? 50;
  const positionSizePct = params.positionSizePct ?? 0; // >0 => ký quỹ theo % equity
  const leverage = params.leverage ?? 1;
  const riskCompound = params.riskCompound ?? true;
  // `compounding` là tham số CHÍNH: false (mặc định) = sizing cố định theo vốn ban đầu; true = lãi kép.
  // `monthlyReset` là ALIAS DEPRECATED cho back-compat: monthlyReset=true ⇒ compounding=false.
  // Nếu người dùng truyền monthlyReset thì nó ĐÈ lên compounding (giữ hành vi cũ).
  let compounding = params.compounding ?? false;
  if (params.monthlyReset !== undefined) compounding = !params.monthlyReset;

  const pf = simulatePortfolio(allTrades, {
    initialCapital: initialCapitalUsdt,
    orderSize: orderSizeUsdt,
    positionSizePct,
    leverage,
    riskPerTradePct,
    riskCompound,
    compounding,
    startTime,
    endTime,
    ddReducePct: params.ddReducePct ?? 0,
    ddReduceFactor: params.ddReduceFactor ?? 0.5,
    ddHaltPct: params.ddHaltPct ?? 0,
    ddResumePct: params.ddResumePct ?? 0,
    dailyLossLimitPct: params.dailyLossLimitPct ?? 0,
    weeklyLossLimitPct: params.weeklyLossLimitPct ?? 0,
  });

  // ----- Chỉ giữ lệnh THỰC MỞ (loại lệnh bị circuit breaker/hết tiền bỏ) cho MỌI thống kê -----
  const taken = allTrades.filter((t) => !t.notTaken);
  const skippedByRisk = allTrades.length - taken.length;

  // perSymbol theo trade THỰC MỞ
  const acceptedBySymbol = new Map<string, BacktestTrade[]>();
  for (const t of taken) {
    const arr = acceptedBySymbol.get(t.symbol) ?? [];
    arr.push(t);
    acceptedBySymbol.set(t.symbol, arr);
  }
  const perSymbol: SymbolResult[] = perSymbolInput.map((s) => {
    const ts = acceptedBySymbol.get(s.symbol) ?? [];
    return {
      symbol: s.symbol,
      candles: s.candles,
      trades: ts.length,
      wins: ts.filter((t) => t.pnlPct > 0).length,
      returnPct: ts.reduce((sum, t) => sum + t.pnlPct, 0),
    };
  });

  const equityCurveUsdt = pf.equityCurveUsdt;
  const maxDrawdownUsdt = pf.maxDrawdownUsdt;
  const totalPnlUsdt = pf.totalPnlUsdt;
  const finalBalance = pf.finalBalanceUsdt;
  const roiPct = pf.roiPct;
  const accountBlown = pf.accountBlown;
  const blownAtTrade = pf.blownAtTrade;
  // byExit theo thứ tự ĐÓNG lệnh — khớp index với equityCurveUsdt (chỉ lệnh THỰC MỞ)
  const byExit = [...taken].sort((a, b) => a.exitTime - b.exitTime);

  // ----- Chuỗi lệnh kéo tài khoản về 0 (để popup xem chi tiết) -----
  let blowupTrades: BlowupTrade[] = [];
  if (accountBlown && blownAtTrade > 0) {
    const end = blownAtTrade; // lệnh tại exit-index (blownAtTrade-1) là lệnh làm cháy
    const start = Math.max(0, end - 15); // lấy tối đa 15 lệnh cuối dẫn tới cháy
    for (let i = start; i < end; i++) {
      const t = byExit[i];
      blowupTrades.push({
        seq: i + 1,
        symbol: t.symbol,
        state: t.state,
        entryTime: t.entryTime,
        exitTime: t.exitTime,
        entryPrice: t.entryPrice,
        exitPrice: t.exitPrice,
        reason: t.reason,
        pnlPct: t.pnlPct,
        pnlUsdt: t.pnlUsdt,
        balanceBefore: i === 0 ? initialCapitalUsdt : equityCurveUsdt[i - 1],
        balanceAfter: equityCurveUsdt[i],
      });
    }
  }

  // ----- Phần trăm (chỉ trên lệnh THỰC MỞ) -----
  const wins = taken.filter((t) => t.pnlPct > 0).length;
  const losses = taken.length - wins;
  const totalReturnPct = taken.reduce((s, t) => s + t.pnlPct, 0);
  const avgReturnPct = taken.length ? totalReturnPct / taken.length : 0;
  const maxWinPct = taken.reduce((m, t) => Math.max(m, t.pnlPct), 0);
  const maxLossPct = taken.reduce((m, t) => Math.min(m, t.pnlPct), 0);
  const avgBarsHeld = taken.length
    ? taken.reduce((s, t) => s + t.barsHeld, 0) / taken.length
    : 0;

  // equityCurve (%) chỉ để vẽ sparkline "tổng %" — KHÔNG dùng cho drawdown.
  // Max drawdown % lấy từ engine danh mục (chuẩn hóa theo peak equity, 0..100).
  const equityCurve: number[] = [];
  let cum = 0;
  for (const t of taken) {
    cum += t.pnlPct;
    equityCurve.push(Number(cum.toFixed(2)));
  }
  const maxDrawdownPct = pf.maxDrawdownPct;

  // ----- Profit Factor / Sharpe / Expectancy(R) — tính trên % biến động giá mỗi lệnh
  //       (độc lập sizing/đòn bẩy, phản ánh chất lượng chiến lược) -----
  let grossProfit = 0;
  let grossLoss = 0;
  const rMultiples: number[] = [];
  for (const t of taken) {
    if (t.pnlPct >= 0) grossProfit += t.pnlPct;
    else grossLoss += -t.pnlPct;
    if (t.riskPctPrice && t.riskPctPrice > 0) rMultiples.push(t.pnlPct / t.riskPctPrice);
  }
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 999 : 0;
  const expectancyR = rMultiples.length
    ? rMultiples.reduce((a, b) => a + b, 0) / rMultiples.length
    : 0;

  // ----- Chuỗi thắng/thua liên tiếp + thời gian giữ lệnh thực (theo thứ tự ĐÓNG lệnh) -----
  let curW = 0, curL = 0, maxConsecutiveWins = 0, maxConsecutiveLosses = 0;
  for (const t of byExit) {
    if (t.pnlPct > 0) {
      curW++; curL = 0;
      if (curW > maxConsecutiveWins) maxConsecutiveWins = curW;
    } else {
      curL++; curW = 0;
      if (curL > maxConsecutiveLosses) maxConsecutiveLosses = curL;
    }
  }
  const avgHoldingHours = taken.length
    ? Number(
        (taken.reduce((s, t) => s + (t.exitTime - t.entryTime), 0) / taken.length / 3_600_000).toFixed(2)
      )
    : 0;

  // Sharpe/Sortino/Calmar/CAGR — annualized từ return NGÀY của equity curve (engine danh mục).
  // sharpe/sortino/calmar có thể null (std/downside/MaxDD = 0 -> không xác định) — giữ nguyên null.
  const round2 = (v: number | null): number | null => (v === null ? null : Number(v.toFixed(2)));
  const sharpe = round2(pf.sharpe);
  const sortino = round2(pf.sortino);
  const calmar = round2(pf.calmar);
  const cagr = pf.cagr;

  return {
    params: {
      months,
      interval,
      takeProfitPct: tpPct,
      stopLossPct: slPct,
      minDropPct: sp.minDropPct!,
      minSidewayCandles: sp.minSidewayCandles!,
      maxSidewayRangePct: sp.maxSidewayRangePct!,
      minRisePct: sp.minRisePct!,
    },
    from: new Date(startTime).toISOString(),
    to: new Date(endTime).toISOString(),
    symbolsTested: symbols,
    totalTrades: taken.length,
    wins,
    losses,
    winRate: taken.length ? (wins / taken.length) * 100 : 0,
    totalReturnPct: Number(totalReturnPct.toFixed(2)),
    avgReturnPct: Number(avgReturnPct.toFixed(2)),
    maxWinPct: Number(maxWinPct.toFixed(2)),
    maxLossPct: Number(maxLossPct.toFixed(2)),
    maxDrawdownPct: Number(maxDrawdownPct.toFixed(2)),
    profitFactor: Number(profitFactor.toFixed(2)),
    profitFactorUsdt: pf.profitFactorUsdt,
    avgWinUsdt: pf.avgWinUsdt,
    avgLossUsdt: pf.avgLossUsdt,
    expectancyUsdt: pf.expectancyUsdt,
    sharpe,
    sortino,
    calmar,
    cagr: Number(cagr.toFixed(2)),
    expectancyR: Number(expectancyR.toFixed(2)),
    maxConsecutiveWins,
    maxConsecutiveLosses,
    avgHoldingHours,
    avgBarsHeld: Number(avgBarsHeld.toFixed(1)),
    equityCurve,
    equityDailyUsdt: pf.equityDailyUsdt,
    initialCapitalUsdt,
    orderSizeUsdt,
    leverage,
    totalPnlUsdt,
    finalBalanceUsdt: Number(finalBalance.toFixed(2)),
    roiPct: Number(roiPct.toFixed(2)),
    maxDrawdownUsdt: Number(maxDrawdownUsdt.toFixed(2)),
    equityCurveUsdt,
    maxConcurrentPositions: maxConcurrent,
    candidateTrades: candidateTradesArr.length,
    skippedByCap: skipped,
    skippedByRisk,
    peakConcurrent: peak,
    marginMode: params.marginMode ?? "CROSS",
    tpSlMode: params.tpSlMode ?? "PRICE",
    liquidations: taken.filter((t) => t.reason === "LIQ").length,
    // % giá đi ngược gây thanh lý = 100/đòn_bẩy − maintenance margin (khớp applyLiquidation).
    liqPriceMovePct: Number((-(100 / (params.leverage ?? 1)) + (params.maintenanceMarginRatePct ?? 0.5)).toFixed(2)),
    accountBlown,
    blownAtTrade,
    blownAt: pf.blownAt,
    blowupTrades,
    byMonth: aggregateByMonth(taken),
    byDay: aggregateByDay(taken),
    byReason: aggregateBy(taken, (t) => t.reason),
    byState: aggregateBy(taken, (t) => t.state),
    byAlignment: aggregateBy(taken, (t) => t.alignment),
    trades: taken.slice(0, 500),
    perSymbol,
  };
}

// ===================== DỮ LIỆU 1M LOCAL (PARQUET) =====================

const INTERVAL_MS: Record<string, number> = {
  "1m": 60_000,
  "15m": 15 * 60_000,
  "1h": 60 * 60_000,
  "4h": 4 * 60 * 60_000,
  "1d": 24 * 60 * 60_000,
};

/** Gộp nến 1m thành khung lớn hơn */
function resampleKlines(klines1m: Kline[], interval: string): Kline[] {
  const ms = INTERVAL_MS[interval] ?? INTERVAL_MS["1h"];
  if (ms === INTERVAL_MS["1m"]) return klines1m;
  const buckets = new Map<number, Kline>();
  for (const k of klines1m) {
    const start = Math.floor(k.openTime / ms) * ms;
    const b = buckets.get(start);
    if (!b) {
      buckets.set(start, {
        openTime: start,
        open: k.open,
        high: k.high,
        low: k.low,
        close: k.close,
        volume: k.volume,
        closeTime: start + ms - 1,
      });
    } else {
      b.high = Math.max(b.high, k.high);
      b.low = Math.min(b.low, k.low);
      b.close = k.close;
      b.volume += k.volume;
    }
  }
  return [...buckets.values()].sort((a, b) => a.openTime - b.openTime);
}

/** Tên file -> symbol. VD "ADA_USDT-USDT.parquet" -> "ADAUSDT" */
function symbolFromFile(filename: string): string {
  const base = filename.replace(/\.parquet$/i, "").split("_USDT-USDT")[0];
  return base.replace(/_/g, "") + "USDT";
}

// Stablecoin/fiat-quote — không có biến động giá đáng kể, loại khỏi scan/backtest.
const STABLE_BASES = new Set([
  "USDC", "BUSD", "TUSD", "FDUSD", "DAI", "USDP", "USDD", "USTC", "UST", "SUSD",
  "LUSD", "FRAX", "GUSD", "USDE", "USD1", "AEUR", "EURI", "EUR", "EURT", "GBP",
  "XUSD", "USDX", "CUSD", "OUSD", "DOLA", "USDJ", "VAI", "MIM", "PYUSD", "USDF",
]);

/** Symbol là stablecoin/fiat quy USDT? (vd USDCUSDT, FDUSDUSDT, EURUSDT) */
export function isStableSymbol(symbol: string): boolean {
  const s = symbol.toUpperCase();
  if (!s.endsWith("USDT")) return false;
  return STABLE_BASES.has(s.slice(0, -4));
}

/** Đọc file parquet nến 1m (lọc theo khoảng thời gian nếu có) */
async function readParquet1m(filePath: string, fromMs?: number, toMs?: number): Promise<Kline[]> {
  const reader = await parquet.ParquetReader.openFile(filePath);
  const cursor = reader.getCursor();
  const out: Kline[] = [];
  let row: any;
  while ((row = await cursor.next())) {
    const ts = Number(row.ts);
    if (fromMs && ts < fromMs) continue;
    if (toMs && ts >= toMs) break; // dữ liệu sắp xếp tăng dần -> dừng sớm
    out.push({
      openTime: ts,
      open: Number(row.open),
      high: Number(row.high),
      low: Number(row.low),
      close: Number(row.close),
      volume: Number(row.volume) || 0,
      closeTime: ts + 60_000 - 1,
    });
  }
  await reader.close();
  return out;
}

// ----- Cache nến đã resample (đọc parquet 1 lần -> JSON nhỏ, lần sau cực nhanh) -----
const CACHE_DIR = path.join(env.DATA_1M_DIR, "_cache");

function cachePath(symbol: string, interval: string): string {
  return path.join(CACHE_DIR, `${symbol}__${interval}.json`);
}

/** Lấy nến đã resample cho 1 symbol+khung. Đọc cache nếu có, không thì build từ parquet rồi lưu cache. */
async function getResampledSeries(symbol: string, file: string, interval: string): Promise<Kline[]> {
  const cp = cachePath(symbol, interval);
  if (fs.existsSync(cp)) {
    try {
      const arr = JSON.parse(fs.readFileSync(cp, "utf8")) as number[][];
      return arr.map((r) => ({
        openTime: r[0],
        open: r[1],
        high: r[2],
        low: r[3],
        close: r[4],
        volume: r[5],
        closeTime: r[0],
      }));
    } catch {
      /* cache hỏng -> build lại */
    }
  }
  const k1m = await readParquet1m(file);
  const res = resampleKlines(k1m, interval);
  try {
    if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
    const compact = res.map((k) => [k.openTime, k.open, k.high, k.low, k.close, k.volume]);
    fs.writeFileSync(cp, JSON.stringify(compact));
  } catch (err) {
    logger.warn("strategy", `Ghi cache ${symbol} lỗi: ${String(err)}`);
  }
  return res;
}

// ----- Đánh giá CHẤT LƯỢNG dữ liệu (lọc coin flatline/chết) -----
// Nhiều file có đoạn dài giá đứng yên + volume=0 (coin ngừng giao dịch/bị delist),
// sau đó "vọt" lên khi có data thật trở lại -> chart sai lệch, làm hỏng backtest.
// Ngưỡng: chuỗi ngày volume=0 liên tiếp >= 10, hoặc >= 5% số ngày có volume=0.
const LOW_QUALITY_MAX_ZERO_RUN = 10;
const LOW_QUALITY_ZERO_RATIO = 0.05;

export interface SymbolQuality {
  symbol: string;
  days: number;
  zeroVolDays: number;
  zeroVolPct: number;
  maxZeroRun: number;
  flagged: boolean;
}

/** Đánh giá 1 symbol từ cache nến 1d (nhanh, đọc JSON nhỏ). null nếu chưa có cache. */
function assessSymbolQuality(symbol: string): SymbolQuality | null {
  const cp = cachePath(symbol, "1d");
  if (!fs.existsSync(cp)) return null;
  try {
    const arr = JSON.parse(fs.readFileSync(cp, "utf8")) as number[][];
    let zero = 0;
    let run = 0;
    let maxRun = 0;
    for (const r of arr) {
      const vol = r[5]; // [openTime, open, high, low, close, volume]
      if (!vol || vol <= 0) {
        zero++;
        run++;
        if (run > maxRun) maxRun = run;
      } else {
        run = 0;
      }
    }
    const days = arr.length;
    const zeroVolPct = days > 0 ? zero / days : 0;
    const flagged = maxRun >= LOW_QUALITY_MAX_ZERO_RUN || zeroVolPct >= LOW_QUALITY_ZERO_RATIO;
    return {
      symbol,
      days,
      zeroVolDays: zero,
      zeroVolPct: Math.round(zeroVolPct * 1000) / 10,
      maxZeroRun: maxRun,
      flagged,
    };
  } catch {
    return null;
  }
}

// Memo hóa để không đọc lại 514 file JSON mỗi lần gọi list.
let qualityMemo: { count: number; map: Map<string, SymbolQuality> } | null = null;

/** Bản đồ chất lượng cho toàn bộ symbol (dùng cache 1d có sẵn). */
export function getQualityMap(): Map<string, SymbolQuality> {
  let files: string[];
  try {
    files = fs.readdirSync(env.DATA_1M_DIR).filter((f) => f.toLowerCase().endsWith(".parquet"));
  } catch {
    return new Map();
  }
  if (qualityMemo && qualityMemo.count === files.length) return qualityMemo.map;

  const map = new Map<string, SymbolQuality>();
  for (const f of files) {
    const sym = symbolFromFile(f);
    const q = assessSymbolQuality(sym);
    if (q) map.set(sym, q);
  }
  qualityMemo = { count: files.length, map };
  return map;
}

/** Symbol có bị đánh dấu dữ liệu xấu không? (chưa có cache 1d -> coi như OK) */
export function isLowQualitySymbol(symbol: string): boolean {
  return getQualityMap().get(symbol.toUpperCase())?.flagged ?? false;
}

/** Danh sách symbol bị loại vì dữ liệu xấu (kèm chỉ số). */
export function listFlaggedSymbols(): SymbolQuality[] {
  return [...getQualityMap().values()].filter((q) => q.flagged).sort((a, b) => b.maxZeroRun - a.maxZeroRun);
}

// Các khung được cache sẵn
const CACHE_INTERVALS = ["15m", "1h", "4h", "1d"];
let cacheBuild = { building: false, done: 0, total: 0 };
export function getCacheBuildProgress() {
  return cacheBuild;
}

/**
 * Tự build cache TẤT CẢ khung cho toàn bộ coin (chạy nền lúc khởi động).
 * Đọc mỗi file parquet 1 lần -> resample ra cả 4 khung -> lưu JSON. Idempotent.
 */
export async function buildAllCache(): Promise<void> {
  let files: string[];
  try {
    files = fs.readdirSync(env.DATA_1M_DIR).filter((f) => f.toLowerCase().endsWith(".parquet"));
  } catch {
    logger.warn("strategy", `Không đọc được thư mục 1m: ${env.DATA_1M_DIR}`);
    return;
  }
  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
  cacheBuild = { building: true, done: 0, total: files.length };
  let built = 0;

  for (const f of files) {
    const symbol = symbolFromFile(f);
    const missing = CACHE_INTERVALS.filter((iv) => !fs.existsSync(cachePath(symbol, iv)));
    if (missing.length) {
      try {
        const k1m = await readParquet1m(path.join(env.DATA_1M_DIR, f));
        for (const iv of missing) {
          const res = resampleKlines(k1m, iv);
          const compact = res.map((k) => [k.openTime, k.open, k.high, k.low, k.close, k.volume]);
          fs.writeFileSync(cachePath(symbol, iv), JSON.stringify(compact));
        }
        built += 1;
      } catch (err) {
        logger.warn("strategy", `Build cache ${symbol} lỗi: ${String(err)}`);
      }
    }
    cacheBuild.done += 1;
  }
  cacheBuild.building = false;
  logger.info("strategy", `Cache nền xong: ${built}/${files.length} coin mới (×${CACHE_INTERVALS.length} khung)`);
}

/** Build cache cho 1 khung trên toàn bộ coin (chạy 1 lần để các lần sau nhanh) */
export async function buildCache(
  interval: string,
  onProgress?: (done: number, total: number, symbol: string) => void
): Promise<{ built: number; cached: number }> {
  const files = fs.readdirSync(env.DATA_1M_DIR).filter((f) => f.toLowerCase().endsWith(".parquet"));
  let done = 0;
  let built = 0;
  let cached = 0;
  for (const f of files) {
    const symbol = symbolFromFile(f);
    done += 1;
    if (fs.existsSync(cachePath(symbol, interval))) {
      cached += 1;
    } else {
      try {
        await getResampledSeries(symbol, path.join(env.DATA_1M_DIR, f), interval);
        built += 1;
      } catch (err) {
        logger.warn("strategy", `Build cache ${symbol} lỗi: ${String(err)}`);
      }
    }
    onProgress?.(done, files.length, symbol);
  }
  logger.info("strategy", `Build cache ${interval}: ${built} mới, ${cached} đã có`);
  return { built, cached };
}

/** Số coin đã có cache cho 1 khung */
export function cacheStatus(interval: string): { cached: number; total: number } {
  try {
    const total = fs
      .readdirSync(env.DATA_1M_DIR)
      .filter((f) => f.toLowerCase().endsWith(".parquet")).length;
    const cached = fs.existsSync(CACHE_DIR)
      ? fs.readdirSync(CACHE_DIR).filter((f) => f.endsWith(`__${interval}.json`)).length
      : 0;
    return { cached, total };
  } catch {
    return { cached: 0, total: 0 };
  }
}

// Memo theo số lượng file để không quét lại metadata mỗi lần gọi.
let rangeMemo: { count: number; range: { minTs: number; maxTs: number } } | null = null;

function tsStat(rg: any, key: "min_value" | "max_value"): number | null {
  const col = (rg?.columns ?? []).find(
    (c: any) => (c?.meta_data?.path_in_schema ?? []).join(".") === "ts"
  );
  const v = col?.meta_data?.statistics?.[key];
  return v == null ? null : Number(v);
}

/**
 * Khoảng thời gian THỰC của toàn bộ dữ liệu local (min/max openTime, ms).
 * Quét column-statistics trong metadata parquet (row-group đầu = min, cuối = max) —
 * nhanh vì không đọc dữ liệu hàng, và ĐÚNG trên mọi symbol (không chỉ file đầu).
 */
export async function getLocalDataRange(): Promise<{ minTs: number; maxTs: number } | null> {
  try {
    const files = fs.readdirSync(env.DATA_1M_DIR).filter((f) => f.toLowerCase().endsWith(".parquet"));
    if (!files.length) return null;
    if (rangeMemo && rangeMemo.count === files.length) return rangeMemo.range;

    let minTs = Infinity;
    let maxTs = -Infinity;
    for (const f of files) {
      try {
        const reader = await parquet.ParquetReader.openFile(path.join(env.DATA_1M_DIR, f));
        const rgs: any[] = (reader.metadata as any)?.row_groups ?? [];
        if (rgs.length) {
          const lo = tsStat(rgs[0], "min_value");
          const hi = tsStat(rgs[rgs.length - 1], "max_value");
          if (lo != null) minTs = Math.min(minTs, lo);
          if (hi != null) maxTs = Math.max(maxTs, hi);
        }
        await reader.close();
      } catch {
        /* bỏ qua file lỗi */
      }
    }

    if (isFinite(minTs) && isFinite(maxTs)) {
      const range = { minTs, maxTs };
      rangeMemo = { count: files.length, range };
      return range;
    }
    // Fallback: đọc 1 file đầy đủ nếu thiếu statistics
    const k1m = await readParquet1m(path.join(env.DATA_1M_DIR, files[0]));
    if (!k1m.length) return null;
    return { minTs: k1m[0].openTime, maxTs: k1m[k1m.length - 1].openTime };
  } catch {
    return null;
  }
}

export function listLocal1mSymbols(includeLowQuality = false): string[] {
  try {
    const quality = includeLowQuality ? null : getQualityMap();
    return fs
      .readdirSync(env.DATA_1M_DIR)
      .filter((f) => f.toLowerCase().endsWith(".parquet"))
      .map(symbolFromFile)
      .filter((s) => !isStableSymbol(s)) // bỏ stablecoin/fiat
      .filter((s) => !quality?.get(s)?.flagged) // bỏ coin dữ liệu xấu (flatline/chết)
      .sort();
  } catch {
    return [];
  }
}

/** Lấy chuỗi nến đã resample của 1 symbol từ DỮ LIỆU 1M LOCAL (parquet). [] nếu không có. */
export async function getLocalSeriesForSymbol(
  symbol: string,
  interval: string
): Promise<Kline[]> {
  const dir = env.DATA_1M_DIR;
  const files = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".parquet"));
  const sym = symbol.toUpperCase();
  const match = files.find((f) => symbolFromFile(f) === sym);
  if (!match) return [];
  return getResampledSeries(sym, path.join(dir, match), interval);
}

/** Đường dẫn file parquet của 1 symbol trong thư mục 1m, null nếu không có. */
function findLocalFile(symbol: string): string | null {
  const dir = env.DATA_1M_DIR;
  const sym = symbol.toUpperCase();
  const files = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".parquet"));
  const match = files.find((f) => symbolFromFile(f) === sym);
  return match ? path.join(dir, match) : null;
}

/**
 * Đọc nến 1m của 1 symbol từ parquet.
 * - Có [fromMs,toMs]: đọc đúng khoảng đó (dừng sớm vì dữ liệu tăng dần), cắt còn `limit` nến cuối.
 * - Không có khoảng: trả `limit` nến CUỐI CÙNG bằng ring buffer (không giữ cả 2 triệu nến trong RAM).
 */
async function getLocal1mTail(
  symbol: string,
  limit: number,
  fromMs?: number,
  toMs?: number
): Promise<Kline[]> {
  const file = findLocalFile(symbol);
  if (!file) return [];

  const reader = await parquet.ParquetReader.openFile(file);
  const cursor = reader.getCursor();
  let row: any;

  if (fromMs || toMs) {
    // Đọc theo khoảng, giữ `limit` nến cuối của khoảng
    const ring: Kline[] = new Array(limit);
    let n = 0;
    while ((row = await cursor.next())) {
      const ts = Number(row.ts);
      if (fromMs && ts < fromMs) continue;
      if (toMs && ts >= toMs) break;
      ring[n % limit] = candleFromRow(row, ts);
      n++;
    }
    await reader.close();
    return ringToArray(ring, n, limit);
  }

  // Không có khoảng -> lấy `limit` nến cuối cùng của cả file
  const ring: Kline[] = new Array(limit);
  let n = 0;
  while ((row = await cursor.next())) {
    ring[n % limit] = candleFromRow(row, Number(row.ts));
    n++;
  }
  await reader.close();
  return ringToArray(ring, n, limit);
}

function candleFromRow(row: any, ts: number): Kline {
  return {
    openTime: ts,
    open: Number(row.open),
    high: Number(row.high),
    low: Number(row.low),
    close: Number(row.close),
    volume: Number(row.volume) || 0,
    closeTime: ts + 60_000 - 1,
  };
}

function ringToArray(ring: Kline[], n: number, limit: number): Kline[] {
  if (n === 0) return [];
  const count = Math.min(n, limit);
  const start = n <= limit ? 0 : n % limit;
  const out: Kline[] = [];
  for (let i = 0; i < count; i++) out.push(ring[(start + i) % limit]);
  return out;
}

/**
 * Nến cho CHART từ dữ liệu 1m LOCAL.
 * - 1m: đọc trực tiếp parquet (theo khoảng nếu có, không thì `limit` nến cuối).
 * - Khung lớn hơn: resample (dùng cache) -> lọc theo khoảng -> cắt còn `limit` nến cuối.
 */
export async function getLocalKlinesForChart(
  symbol: string,
  interval: string,
  limit: number,
  fromMs?: number,
  toMs?: number
): Promise<Kline[]> {
  if (interval === "1m") return getLocal1mTail(symbol, limit, fromMs, toMs);

  let series = await getLocalSeriesForSymbol(symbol, interval);
  if (fromMs) series = series.filter((k) => k.openTime >= fromMs);
  if (toMs) series = series.filter((k) => k.openTime < toMs);
  return series.slice(-limit);
}

/** Khoảng thời gian (min/max openTime, ms) của 1 symbol — đọc từ metadata parquet (nhanh). */
export async function getLocalSymbolRange(
  symbol: string
): Promise<{ minTs: number; maxTs: number } | null> {
  const file = findLocalFile(symbol);
  if (!file) return null;
  try {
    const reader = await parquet.ParquetReader.openFile(file);
    const rgs: any[] = (reader.metadata as any)?.row_groups ?? [];
    let minTs: number | null = null;
    let maxTs: number | null = null;
    if (rgs.length) {
      minTs = tsStat(rgs[0], "min_value");
      maxTs = tsStat(rgs[rgs.length - 1], "max_value");
    }
    await reader.close();
    if (minTs != null && maxTs != null) return { minTs, maxTs };
  } catch {
    /* rơi xuống fallback */
  }
  // Fallback: đọc file đầy đủ (chậm hơn) nếu thiếu statistics
  const k = await readParquet1m(file);
  if (!k.length) return null;
  return { minTs: k[0].openTime, maxTs: k[k.length - 1].openTime };
}

// ----- Funding rate LỊCH SỬ (cache đĩa) -----
const FUNDING_CACHE_DIR = path.join(env.DATA_1M_DIR, "_cache", "_funding");

/** Lấy funding lịch sử 1 symbol (cache JSON). Rỗng nếu fetch lỗi (offline). */
export async function getFundingCached(
  symbol: string,
  fromMs: number,
  toMs: number
): Promise<{ time: number; rate: number }[]> {
  const fp = path.join(FUNDING_CACHE_DIR, `${symbol}.json`);
  let data: { time: number; rate: number }[] = [];
  if (fs.existsSync(fp)) {
    try {
      data = JSON.parse(fs.readFileSync(fp, "utf8"));
    } catch {
      data = [];
    }
  }
  // Cache đã bao phủ khoảng cần? (đệm 8h mỗi đầu)
  const covers =
    data.length > 0 &&
    data[0].time <= fromMs + 8 * 3_600_000 &&
    data[data.length - 1].time >= toMs - 8 * 3_600_000;
  if (!covers) {
    try {
      data = await binance.getFundingRateHistory(symbol, fromMs, toMs);
      if (!fs.existsSync(FUNDING_CACHE_DIR)) fs.mkdirSync(FUNDING_CACHE_DIR, { recursive: true });
      fs.writeFileSync(fp, JSON.stringify(data));
    } catch (err) {
      logger.warn("strategy", `Funding ${symbol} lỗi (dùng ước lượng): ${String(err)}`);
    }
  }
  return data;
}

/**
 * MÔ HÌNH THANH LÝ (liquidation). Với đòn bẩy L, một vị thế bị thanh lý khi giá đi NGƯỢC
 * chạm ngưỡng `liqPct = 100/L − maintenanceMarginRate` (%) — lúc đó mất ~toàn bộ margin.
 * Nếu MAE (biến động bất lợi nhất khi giữ lệnh) của trade chạm ngưỡng này TRƯỚC khi thoát bình thường,
 * trade bị chuyển thành LIQ: lỗ = −liqPct (mất margin), thoát tại maeTime, bỏ phần lời sau đó.
 * → Đòn bẩy cao ⇒ liqPct nhỏ ⇒ nhiều lệnh bị thanh lý (KHÔNG còn bất biến leverage như trước).
 * Áp cho cả CROSS/ISOLATED (ISOLATED chính xác; CROSS là xấp xỉ bảo thủ ở cấp vị thế).
 */
function applyLiquidation(trades: BacktestTrade[], leverage: number, mmrPct: number): number {
  if (!leverage || leverage <= 1) return 0;
  const liqPct = -(100 / leverage) + mmrPct; // % biến động bất lợi wipe margin (âm)
  let n = 0;
  for (const t of trades) {
    if (t.reason !== "LIQ" && t.maePct !== undefined && t.maePct <= liqPct && t.pnlPct > liqPct) {
      t.pnlPct = Number(liqPct.toFixed(4)); // mất toàn bộ margin
      // Giá thanh lý = giá tại đó leg-pnl = liqPct (LONG: entry giảm; SHORT: entry tăng).
      const side = t.side ?? "LONG";
      const liqPrice = side === "SHORT"
        ? t.entryPrice * (1 - liqPct / 100)
        : t.entryPrice * (1 + liqPct / 100);
      t.exitPrice = Number(liqPrice.toFixed(8));
      t.reason = "LIQ";
      if (t.maeTime !== undefined) t.exitTime = t.maeTime;
      t.mfePct = 0; // đã bị thanh lý -> không còn phần lời sau đó
      n++;
    }
  }
  return n;
}

/** Gán funding THỰC cho từng trade: t.fundingPct = Σ rate ở các mốc trong (entry, exit], quy ra %. */
function applyRealFunding(trades: BacktestTrade[], rates: { time: number; rate: number }[]): void {
  if (!rates.length) return;
  for (const t of trades) {
    let sum = 0;
    for (const f of rates) {
      if (f.time > t.exitTime) break;
      if (f.time > t.entryTime) sum += f.rate;
    }
    t.fundingPct = sum * 100; // rate là phân số -> %
  }
}

/**
 * Backtest trên DỮ LIỆU 1M LOCAL (parquet trên đĩa server).
 * Resample 1m -> khung yêu cầu, chạy chiến lược. onProgress để cập nhật job nền.
 */
export async function runLocal1mBacktest(
  params: BacktestParams,
  onProgress?: (done: number, total: number, symbol: string) => void
): Promise<BacktestResult> {
  const interval = params.interval ?? "1h";
  const tpPct = params.takeProfitPct ?? 30;
  const slPct = params.stopLossPct ?? 15;
  const leverage = params.leverage ?? 1;
  const marginMode = params.marginMode ?? "CROSS";
  const tpSlMode = params.tpSlMode ?? "PRICE";
  const mmr = params.maintenanceMarginRatePct ?? 0.5;
  const sp: StrategyParams = {
    minDropPct: params.minDropPct ?? 15,
    minSidewayCandles: params.minSidewayCandles ?? 20,
    maxSidewayRangePct: params.maxSidewayRangePct ?? 5,
    minRisePct: params.minRisePct ?? 10,
  };
  let fromMs = params.fromMs;
  let toMs = params.toMs;
  // Nếu chỉ truyền `months` (không có mốc cụ thể) -> giới hạn N tháng CUỐI của dữ liệu local.
  // Trước đây `months` bị bỏ qua khiến backtest chạy toàn bộ ~4.5 năm dù người dùng chọn "12 tháng".
  if (!fromMs && !toMs && params.months && params.months > 0) {
    const range = await getLocalDataRange();
    if (range) {
      toMs = range.maxTs;
      fromMs = range.maxTs - params.months * 30 * DAY_MS;
    }
  }

  const dir = env.DATA_1M_DIR;
  let files = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".parquet"));
  const allEntries = files.map((f) => ({ file: path.join(dir, f), symbol: symbolFromFile(f) }));
  // SURVIVORSHIP/LOOK-AHEAD: isLowQualitySymbol() đánh giá trên TOÀN BỘ lịch sử file (chưa point-in-time)
  // -> log rõ symbol bị loại + lý do để audit. Universe = coin đang có mặt trong data local (coin delist
  // không có mặt) => kết quả nghiêng survivorship-bias tích cực. Xem mục 8 backtest.md.
  const droppedLowQ = allEntries.filter((e) => !isStableSymbol(e.symbol) && isLowQualitySymbol(e.symbol));
  if (droppedLowQ.length) {
    logger.info(
      "strategy",
      `Loại ${droppedLowQ.length} symbol dữ liệu xấu (flatline/chết, không point-in-time): ${droppedLowQ.map((e) => e.symbol).join(", ")}`
    );
  }
  let entries = allEntries
    .filter((e) => !isStableSymbol(e.symbol)) // bỏ stablecoin/fiat
    .filter((e) => !isLowQualitySymbol(e.symbol)); // bỏ coin dữ liệu xấu (flatline/chết)
  if (params.symbols && params.symbols.length) {
    const want = new Set(params.symbols.map((s) => s.toUpperCase()));
    entries = entries.filter((e) => want.has(e.symbol));
  }

  logger.info("strategy", `Backtest LOCAL 1m: ${entries.length} file, khung ${interval}`);

  const allTrades: BacktestTrade[] = [];
  const perSymbol: SymbolResult[] = [];
  let minT = Infinity;
  let maxT = -Infinity;
  let done = 0;

  for (const e of entries) {
    try {
      // Có khoảng tháng + đã tách -> đọc file tháng (nhanh); ngược lại đọc full + lọc
      let candles = await getResampledSeries(e.symbol, e.file, interval);
      if (fromMs && toMs) candles = candles.filter((k) => k.openTime >= fromMs && k.openTime < toMs);
      if (candles.length >= 60) {
        minT = Math.min(minT, candles[0].openTime);
        maxT = Math.max(maxT, candles[candles.length - 1].openTime);
        const trades = simulateSymbol(e.symbol, candles, tpPct, slPct, sp, leverage, marginMode, tpSlMode, mmr);
        if (params.useRealFunding && trades.length) {
          const rates = await getFundingCached(
            e.symbol,
            candles[0].openTime,
            candles[candles.length - 1].openTime
          );
          applyRealFunding(trades, rates);
        }
        perSymbol.push({
          symbol: e.symbol,
          candles: candles.length,
          trades: trades.length,
          wins: trades.filter((t) => t.pnlPct > 0).length,
          returnPct: trades.reduce((s, t) => s + t.pnlPct, 0),
        });
        allTrades.push(...trades);
      } else {
        perSymbol.push({ symbol: e.symbol, candles: candles.length, trades: 0, wins: 0, returnPct: 0 });
      }
    } catch (err) {
      logger.warn("strategy", `Đọc ${e.symbol} lỗi: ${String(err)}`);
      perSymbol.push({ symbol: e.symbol, candles: 0, trades: 0, wins: 0, returnPct: 0 });
    }
    done += 1;
    onProgress?.(done, entries.length, e.symbol);
    // Nhường event loop định kỳ để không "đói" các request HTTP khác
    // (parquet cache hit -> vòng lặp thuần CPU, dễ chặn event loop nhiều giây).
    if (done % 8 === 0) await new Promise<void>((r) => setImmediate(r));
  }

  return buildResult(allTrades, perSymbol, {
    params,
    sp,
    months: 0,
    interval,
    tpPct,
    slPct,
    startTime: isFinite(minT) ? minT : 0,
    endTime: isFinite(maxT) ? maxT : 0,
    symbols: entries.map((e) => e.symbol),
  });
}

/**
 * Backtest từ DỮ LIỆU IMPORT (file của người dùng, đã resample sẵn ở frontend).
 * Không gọi Binance — chạy chiến lược trực tiếp trên nến được cung cấp.
 */
export function runImportedBacktest(
  params: BacktestParams,
  data: { symbol: string; candles: Kline[] }[]
): BacktestResult {
  const interval = params.interval ?? "1h";
  const tpPct = params.takeProfitPct ?? 30;
  const slPct = params.stopLossPct ?? 15;
  const leverage = params.leverage ?? 1;
  const marginMode = params.marginMode ?? "CROSS";
  const tpSlMode = params.tpSlMode ?? "PRICE";
  const mmr = params.maintenanceMarginRatePct ?? 0.5;
  const sp: StrategyParams = {
    minDropPct: params.minDropPct ?? 15,
    minSidewayCandles: params.minSidewayCandles ?? 20,
    maxSidewayRangePct: params.maxSidewayRangePct ?? 5,
    minRisePct: params.minRisePct ?? 10,
  };

  const allTrades: BacktestTrade[] = [];
  const perSymbol: SymbolResult[] = [];
  let minT = Infinity;
  let maxT = -Infinity;

  for (const { symbol, candles } of data) {
    if (!candles || candles.length < 60) {
      perSymbol.push({ symbol, candles: candles?.length ?? 0, trades: 0, wins: 0, returnPct: 0 });
      continue;
    }
    minT = Math.min(minT, candles[0].openTime);
    maxT = Math.max(maxT, candles[candles.length - 1].openTime);
    const trades = simulateSymbol(symbol, candles, tpPct, slPct, sp, leverage, marginMode, tpSlMode, mmr);
    perSymbol.push({
      symbol,
      candles: candles.length,
      trades: trades.length,
      wins: trades.filter((t) => t.pnlPct > 0).length,
      returnPct: trades.reduce((s, t) => s + t.pnlPct, 0),
    });
    allTrades.push(...trades);
  }

  logger.info("strategy", `Backtest IMPORT ${data.length} symbol, khung ${interval}`);

  return buildResult(allTrades, perSymbol, {
    params,
    sp,
    months: 0,
    interval,
    tpPct,
    slPct,
    startTime: isFinite(minT) ? minT : 0,
    endTime: isFinite(maxT) ? maxT : 0,
    symbols: data.map((d) => d.symbol),
  });
}

/**
 * Backtest TOÀN SÀN: quét tất cả symbol active trong DB.
 * onProgress(done, total, symbol) để cập nhật job nền.
 */
export async function runFullExchangeBacktest(
  params: BacktestParams,
  onProgress?: (done: number, total: number, symbol: string) => void
): Promise<BacktestResult> {
  const months = params.months ?? 3;
  const interval = params.interval ?? "15m";
  const tpPct = params.takeProfitPct ?? 30;
  const slPct = params.stopLossPct ?? 15;
  const sp: StrategyParams = {
    minDropPct: params.minDropPct ?? 15,
    minSidewayCandles: params.minSidewayCandles ?? 20,
    maxSidewayRangePct: params.maxSidewayRangePct ?? 5,
    minRisePct: params.minRisePct ?? 10,
  };

  const coins = await prisma.coin.findMany({ where: { active: true }, select: { symbol: true } });
  const symbols = coins.map((c) => c.symbol);

  const { startTime, endTime } = resolveRange(params);

  logger.info(
    "strategy",
    `Backtest TOÀN SÀN ${symbols.length} symbol, ${months} tháng, trần ${params.maxConcurrentPositions ?? 0} vị thế`
  );

  const allTrades: BacktestTrade[] = [];
  const perSymbol: SymbolResult[] = [];

  // Xử lý theo lô để vừa nhanh vừa hạn chế rate-limit (5 symbol song song)
  const leverage = params.leverage ?? 1;
  const marginMode = params.marginMode ?? "CROSS";
  const tpSlMode = params.tpSlMode ?? "PRICE";
  const mmr = params.maintenanceMarginRatePct ?? 0.5;
  const CONCURRENCY = 5;
  let done = 0;
  for (let i = 0; i < symbols.length; i += CONCURRENCY) {
    const batch = symbols.slice(i, i + CONCURRENCY);
    await Promise.all(
      batch.map((symbol) =>
        simulateOneSymbol(
          symbol, interval, startTime, endTime, tpPct, slPct, sp, leverage, marginMode, tpSlMode, mmr, allTrades, perSymbol
        ).then(() => {
          done += 1;
          onProgress?.(done, symbols.length, symbol);
        })
      )
    );
  }

  return buildResult(allTrades, perSymbol, {
    params,
    sp,
    months,
    interval,
    tpPct,
    slPct,
    startTime,
    endTime,
    symbols,
  });
}

// ===================== BACKTEST THEO EMA CLASSIFIER =====================

export interface EmaBacktestParams extends BacktestParams {
  fastPeriod?: number; // EMA nhanh (mặc định 9)
  slowPeriod?: number; // EMA chậm (mặc định 21)
  epsilonMode?: EpsilonMode; // "atr" | "percent" | "absolute"
  epsilonValue?: number;
  atrPeriod?: number; // mặc định 14
  direction?: "LONG" | "SHORT" | "BOTH"; // chiều vào lệnh mặc định
  entryStates?: string[]; // state phát tín hiệu vào lệnh (vd ["LONG1","LONG2"])
  // ----- v1.1: chiến thuật TP/SL theo alignment -----
  exitStrategy?: "simple" | "alignment"; // simple = TP/SL % cố định; alignment = theo spec v1.1
  swingLookback?: number; // số nến tìm swing high/low (mặc định 10)
  emaBufferAtr?: number; // đệm SL = emaBufferAtr × ATR (mặc định 0.25)
  slAnchor?: "atr" | "structure" | "protective"; // cách neo SL (mặc định protective)
  slAtrMult?: number; // dùng cho neo "atr"/"protective" (mặc định 1.5)
  globalExitOverlay?: boolean; // lật sang bias ngược -> đóng ngay (mặc định true)
  hardExit?: boolean; // hard_exit theo alignment (mặc định true)
  // riskPerTradePct kế thừa từ BacktestParams (sizing R-based cho mode alignment)
}

const ALIGNMENT_SCORE: Record<string, number> = {
  MOMENTUM: 75,
  PULLBACK: 55,
  REVERSAL: 35,
  NONE: 0,
};

interface EmaSimCfg {
  fastPeriod: number;
  slowPeriod: number;
  epsilonMode?: EpsilonMode;
  epsilonValue?: number;
  atrPeriod?: number;
  tpPct: number;
  slPct: number;
  leverage: number;
  marginMode: "CROSS" | "ISOLATED";
  tpSlMode: "PRICE" | "MARGIN";
  entryStates: Set<string>;
  mmr: number; // maintenance margin rate (% notional) cho giá thanh lý ISOLATED
}

/**
 * Mô phỏng 1 symbol theo EMA classifier.
 * Vào lệnh khi có TÍN HIỆU (state đổi) vào một state cho phép; chiều lệnh = bias của state.
 * Thoát theo TP/SL (LIQ nếu Isolated) — giống engine backtest gốc, có phân biệt LONG/SHORT.
 */
export function simulateSymbolEma(symbol: string, klines: Kline[], cfg: EmaSimCfg): BacktestTrade[] {
  const trades: BacktestTrade[] = [];
  const series = classifySeries(klines, {
    fastPeriod: cfg.fastPeriod,
    slowPeriod: cfg.slowPeriod,
    epsilonMode: cfg.epsilonMode,
    epsilonValue: cfg.epsilonValue,
    atrPeriod: cfg.atrPeriod,
  });

  const tpMove = cfg.tpSlMode === "MARGIN" ? cfg.tpPct / cfg.leverage : cfg.tpPct;
  const slMove = cfg.tpSlMode === "MARGIN" ? cfg.slPct / cfg.leverage : cfg.slPct;
  // Adverse move tới thanh lý = (100/đòn bẩy − mmr)% (maintenance margin -> cháy sớm hơn).
  const liqAdvPct = 100 / cfg.leverage - cfg.mmr;
  const useLiq = cfg.marginMode === "ISOLATED";

  let i = 0;
  while (i < series.length) {
    const c = series[i];
    if (!c.isSignal || c.cls.bias === "NONE" || !cfg.entryStates.has(c.cls.state)) {
      i++;
      continue;
    }
    const long = c.cls.bias === "LONG";
    const entry = c.close;
    const tp = long ? entry * (1 + tpMove / 100) : entry * (1 - tpMove / 100);
    const sl = long ? entry * (1 - slMove / 100) : entry * (1 + slMove / 100);
    const liq = long ? entry * (1 - liqAdvPct / 100) : entry * (1 + liqAdvPct / 100);

    // Isolated: nếu mức thanh lý GẦN entry hơn SL -> bị cháy trước khi tới SL.
    let stop = sl;
    let stopReason: BacktestTrade["reason"] = "SL";
    if (useLiq && ((long && liq > sl) || (!long && liq < sl))) {
      stop = liq;
      stopReason = "LIQ";
    }

    const legPnl = (px: number) => (long ? ((px - entry) / entry) * 100 : ((entry - px) / entry) * 100);
    let exitIdx = -1;
    let exitPrice = 0;
    let reason: BacktestTrade["reason"] = "EOD";
    let worstAdvPct = 0; // MAE (≤ 0)
    let worstAdvTime = klines[i].openTime;
    let bestFavPct = 0; // MFE (≥ 0)
    let bestFavTime = klines[i].openTime;
    for (let j = i + 1; j < klines.length; j++) {
      const k = klines[j];
      // MAE/MFE: phía bất lợi = low(long)/high(short); phía thuận lợi = high(long)/low(short).
      const advP = legPnl(long ? k.low : k.high);
      const favP = legPnl(long ? k.high : k.low);
      if (advP < worstAdvPct) { worstAdvPct = advP; worstAdvTime = k.openTime; }
      if (favP > bestFavPct) { bestFavPct = favP; bestFavTime = k.openTime; }
      // bi quan: phía bất lợi (stop) xét trước. Gap qua stop -> fill tại open (tệ hơn).
      const hitStop = long ? k.low <= stop : k.high >= stop;
      if (hitStop) {
        exitIdx = j;
        const gapped = long ? k.open < stop : k.open > stop;
        exitPrice = gapped ? k.open : stop;
        reason = stopReason;
        break;
      }
      // TP limit: gap thuận lợi vẫn fill tại tp (không lấy bonus).
      const hitTP = long ? k.high >= tp : k.low <= tp;
      if (hitTP) {
        exitIdx = j;
        exitPrice = tp;
        reason = "TP";
        break;
      }
    }
    if (exitIdx === -1) {
      exitIdx = klines.length - 1;
      exitPrice = klines[exitIdx].close;
      reason = "EOD";
    }

    const pnlPct = legPnl(exitPrice);
    trades.push({
      symbol,
      side: long ? "LONG" : "SHORT",
      maePct: Math.min(0, worstAdvPct),
      maeTime: worstAdvTime,
      mfePct: Math.max(0, bestFavPct),
      mfeTime: bestFavTime,
      entryTime: klines[i].openTime,
      entryPrice: entry,
      exitTime: klines[exitIdx].openTime,
      exitPrice,
      pnlPct,
      pnlUsdt: 0,
      reason,
      barsHeld: exitIdx - i,
      probability: ALIGNMENT_SCORE[c.cls.alignment] ?? 0,
      riskPctPrice: Math.abs(((entry - stop) / entry) * 100),
      state: c.cls.state,
      alignment: c.cls.alignment,
    });
    i = exitIdx + 1; // không chồng lệnh trên cùng symbol
  }
  return trades;
}

interface EmaAlignCfg {
  fastPeriod: number;
  slowPeriod: number;
  epsilonMode?: EpsilonMode;
  epsilonValue?: number;
  atrPeriod?: number;
  entryStates: Set<string>;
  swingLookback: number;
  emaBufferAtr: number;
  slAnchor: "atr" | "structure" | "protective";
  slAtrMult: number;
  globalExitOverlay: boolean;
  hardExit: boolean;
  leverage: number; // dùng cho thanh lý (ISOLATED)
  marginMode: "CROSS" | "ISOLATED"; // ISOLATED => thanh lý từng lệnh ở ~100/đòn bẩy %; CROSS => SL bảo vệ, không cháy lẻ
  mmr: number; // maintenance margin rate (% notional) cho giá thanh lý ISOLATED
}

/**
 * Mô phỏng 1 symbol theo CHIẾN THUẬT TP/SL v1.1 (khác nhau theo alignment).
 * - SL: MOMENTUM neo sau EMA Slow/swing (rộng); PULLBACK sau EMA Slow; REVERSAL sau swing (chặt).
 *   slAnchor: atr | structure | protective (chọn mức XA hơn giữa atr & structure).
 * - R = |entry - SL|. TP ghi theo bội số R hoặc mục tiêu EMA (REVERSAL).
 * - Chốt 50% tại TP1, phần còn lại trailing theo EMA Fast (PULLBACK dời SL hòa vốn sau TP1).
 * - hard_exit: cấu trúc lật / close vượt EMA Slow (PULLBACK). global overlay: bias lật ngược -> đóng hết.
 * - pnlPct = tổng (tỷ trọng × % của từng lần chốt). riskPctPrice = R/entry×100 (cho R-based sizing).
 */
function simulateSymbolEmaAlignment(
  symbol: string,
  klines: Kline[],
  cfg: EmaAlignCfg
): BacktestTrade[] {
  const trades: BacktestTrade[] = [];
  const series = classifySeries(klines, {
    fastPeriod: cfg.fastPeriod,
    slowPeriod: cfg.slowPeriod,
    epsilonMode: cfg.epsilonMode,
    epsilonValue: cfg.epsilonValue,
    atrPeriod: cfg.atrPeriod,
  });
  const n = klines.length;

  const swingLow = (end: number) => {
    let lo = Infinity;
    for (let k = Math.max(0, end - cfg.swingLookback); k < end; k++) lo = Math.min(lo, klines[k].low);
    return Number.isFinite(lo) ? lo : klines[end].low;
  };
  const swingHigh = (end: number) => {
    let hi = -Infinity;
    for (let k = Math.max(0, end - cfg.swingLookback); k < end; k++) hi = Math.max(hi, klines[k].high);
    return Number.isFinite(hi) ? hi : klines[end].high;
  };

  let i = 0;
  while (i < n) {
    const c = series[i];
    if (!c.isSignal || c.cls.bias === "NONE" || !cfg.entryStates.has(c.cls.state)) {
      i++;
      continue;
    }
    const long = c.cls.bias === "LONG";
    const align = c.cls.alignment; // MOMENTUM | PULLBACK | REVERSAL
    const entry = c.close;
    const emaFast = c.fast;
    const emaSlow = c.slow;
    const atr = Number.isFinite(c.atr) ? c.atr : 0;
    if (!Number.isFinite(emaFast) || !Number.isFinite(emaSlow)) {
      i++;
      continue;
    }
    const buf = cfg.emaBufferAtr * atr;
    const sLow = swingLow(i);
    const sHigh = swingHigh(i);

    // ---- SL theo cấu trúc (structure) ----
    let structSL: number;
    if (long) {
      structSL =
        align === "MOMENTUM" ? Math.min(emaSlow, sLow) - buf : align === "PULLBACK" ? emaSlow - buf : sLow - buf;
    } else {
      structSL =
        align === "MOMENTUM" ? Math.max(emaSlow, sHigh) + buf : align === "PULLBACK" ? emaSlow + buf : sHigh + buf;
    }
    // ---- SL theo ATR & protective ----
    const atrSL = long ? entry - cfg.slAtrMult * atr : entry + cfg.slAtrMult * atr;
    let sl =
      cfg.slAnchor === "atr"
        ? atrSL
        : cfg.slAnchor === "structure"
        ? structSL
        : long
        ? Math.min(structSL, atrSL) // protective = xa entry hơn (an toàn hơn)
        : Math.max(structSL, atrSL);
    // đảm bảo SL đúng phía
    if (long && sl >= entry) sl = entry - Math.max(buf, entry * 0.0005);
    if (!long && sl <= entry) sl = entry + Math.max(buf, entry * 0.0005);

    const R = Math.abs(entry - sl);
    if (R <= 0) {
      i++;
      continue;
    }

    // ---- Mức thanh lý theo đòn bẩy: CHỈ áp cho ISOLATED. Cross dùng cả số dư nên SL bảo vệ, không cháy lẻ.
    // Adverse move tới liq = (100/đòn bẩy − mmr)% (maintenance margin -> cháy sớm hơn, bi quan).
    const useLiq = cfg.marginMode === "ISOLATED" && cfg.leverage > 1;
    const liqMove = useLiq ? 100 / cfg.leverage - cfg.mmr : Infinity;
    const liqPrice = long ? entry * (1 - liqMove / 100) : entry * (1 + liqMove / 100);
    // R rủi ro thực tại entry: nếu LIQ chặn TRƯỚC SL ban đầu -> tới liq (không dùng |entry−sl|).
    const liqCloserThanSL = useLiq && (long ? liqPrice > sl : liqPrice < sl);
    const riskStop = liqCloserThanSL ? liqPrice : sl;

    // ---- TP & cấu hình thoát theo alignment ----
    let tp1: number;
    let fracTP1: number;
    let doTrail: boolean;
    let breakevenAfterTP1: boolean;
    let reversal = false;
    if (align === "MOMENTUM") {
      tp1 = long ? entry + 2 * R : entry - 2 * R;
      fracTP1 = 0.5;
      doTrail = true;
      breakevenAfterTP1 = false;
    } else if (align === "PULLBACK") {
      tp1 = long ? entry + 1.5 * R : entry - 1.5 * R;
      fracTP1 = 0.5;
      doTrail = true;
      breakevenAfterTP1 = true;
    } else {
      // REVERSAL: mục tiêu hồi quy về EMA Slow, tối đa ~1R, chốt 100%
      const cap = long ? entry + R : entry - R;
      tp1 = long ? Math.min(emaSlow, cap) : Math.max(emaSlow, cap);
      if (long && tp1 <= entry) tp1 = entry + R;
      if (!long && tp1 >= entry) tp1 = entry - R;
      fracTP1 = 1.0;
      doTrail = false;
      breakevenAfterTP1 = false;
      reversal = true;
    }

    const legPnl = (px: number) => (long ? ((px - entry) / entry) * 100 : ((entry - px) / entry) * 100);

    let remaining = 1.0;
    let realizedPnlPct = 0;
    let curSL = sl;
    let tp1Hit = false;
    let exitIdx = -1;
    let reason: BacktestTrade["reason"] = "EOD";
    let worstAdvPct = 0; // MAE: % lãi/lỗ tệ nhất (adverse) trong lúc giữ lệnh
    let worstAdvTime = klines[i].openTime;
    let bestFavPct = 0; // MFE: % lãi/lỗ thuận lợi nhất trong lúc giữ lệnh
    let bestFavTime = klines[i].openTime;

    for (let j = i + 1; j < n; j++) {
      const k = klines[j];
      const fastJ = series[j].fast;
      const slowJ = series[j].slow;
      const biasJ = series[j].cls.bias;
      const closeJ = k.close;

      // MAE: phía bất lợi = low (long) / high (short). MFE: phía thuận lợi = high (long) / low (short).
      const advPnl = legPnl(long ? k.low : k.high);
      if (advPnl < worstAdvPct) {
        worstAdvPct = advPnl;
        worstAdvTime = k.openTime;
      }
      const favPnl = legPnl(long ? k.high : k.low);
      if (favPnl > bestFavPct) {
        bestFavPct = favPnl;
        bestFavTime = k.openTime;
      }

      // (1) Intrabar (bi quan): chặn phía bất lợi = mức GẦN entry hơn giữa SL và giá thanh lý.
      // Nếu đòn bẩy cao khiến giá thanh lý gần hơn SL -> cháy trước khi tới SL.
      let advStop = curSL;
      let advReason: BacktestTrade["reason"] = curSL === sl ? "SL" : "TRAIL";
      if (useLiq && (long ? liqPrice > curSL : liqPrice < curSL)) {
        advStop = liqPrice;
        advReason = "LIQ";
      }
      const hitSL = long ? k.low <= advStop : k.high >= advStop;
      if (hitSL) {
        // Gap: nếu nến MỞ đã vượt qua mức chặn -> fill tại open (tệ hơn advStop).
        const gapped = long ? k.open < advStop : k.open > advStop;
        realizedPnlPct += remaining * legPnl(gapped ? k.open : advStop);
        reason = advReason;
        exitIdx = j;
        break;
      }
      const hitTP1 = !tp1Hit && (long ? k.high >= tp1 : k.low <= tp1);
      if (hitTP1) {
        realizedPnlPct += fracTP1 * legPnl(tp1);
        remaining -= fracTP1;
        tp1Hit = true;
        if (reversal || remaining <= 0.0001) {
          reason = "TP";
          exitIdx = j;
          break;
        }
        if (breakevenAfterTP1) curSL = entry;
      }

      // (2) Cuối nến: global overlay -> hard_exit -> trailing
      if (cfg.globalExitOverlay && ((long && biasJ === "SHORT") || (!long && biasJ === "LONG"))) {
        realizedPnlPct += remaining * legPnl(closeJ);
        reason = "FLIP";
        exitIdx = j;
        break;
      }
      if (cfg.hardExit) {
        const fin = Number.isFinite(fastJ) && Number.isFinite(slowJ);
        const flipped =
          align === "PULLBACK"
            ? (long && closeJ < slowJ) || (!long && closeJ > slowJ)
            : fin && (long ? fastJ < slowJ : fastJ > slowJ);
        if (flipped) {
          realizedPnlPct += remaining * legPnl(closeJ);
          reason = "FLIP";
          exitIdx = j;
          break;
        }
      }
      // Trailing chỉ quản phần CÒN LẠI sau khi đã chốt TP1 (cả MOMENTUM & PULLBACK).
      if (doTrail && tp1Hit && Number.isFinite(fastJ)) {
        if ((long && closeJ < fastJ) || (!long && closeJ > fastJ)) {
          realizedPnlPct += remaining * legPnl(closeJ);
          reason = "TRAIL";
          exitIdx = j;
          break;
        }
      }
    }
    if (exitIdx === -1) {
      const last = n - 1;
      realizedPnlPct += remaining * legPnl(klines[last].close);
      reason = tp1Hit ? "TP" : "EOD";
      exitIdx = last;
    }

    const effExit = long ? entry * (1 + realizedPnlPct / 100) : entry * (1 - realizedPnlPct / 100);
    trades.push({
      symbol,
      side: long ? "LONG" : "SHORT",
      maePct: Math.min(0, worstAdvPct),
      maeTime: worstAdvTime,
      mfePct: Math.max(0, bestFavPct),
      mfeTime: bestFavTime,
      entryTime: klines[i].openTime,
      entryPrice: entry,
      exitTime: klines[exitIdx].openTime,
      exitPrice: effExit,
      pnlPct: realizedPnlPct,
      pnlUsdt: 0,
      reason,
      barsHeld: exitIdx - i,
      probability: ALIGNMENT_SCORE[align] ?? 0,
      // R theo mức chặn thực tại entry (liq nếu chặn trước SL, else |entry−SL|).
      riskPctPrice: Math.abs(((entry - riskStop) / entry) * 100),
      state: c.cls.state,
      alignment: align,
    });
    i = exitIdx + 1;
  }
  return trades;
}

/** Suy ra tập state vào lệnh từ params (mặc định theo direction) */
function resolveEntryStates(params: EmaBacktestParams): Set<string> {
  const set = new Set<string>((params.entryStates ?? []).map((s) => s.toUpperCase()));
  if (set.size === 0) {
    const dir = params.direction ?? "LONG";
    if (dir === "LONG" || dir === "BOTH") set.add("LONG1");
    if (dir === "SHORT" || dir === "BOTH") set.add("SHORT1");
  }
  return set;
}

/**
 * Backtest EMA classifier trên DỮ LIỆU 1M LOCAL (parquet). Resample -> khung, chạy nền.
 * Tái dùng buildResult nên kết quả có đủ theo tháng / theo symbol / chi tiết lệnh.
 */
export async function runEmaLocal1mBacktest(
  params: EmaBacktestParams,
  onProgress?: (done: number, total: number, symbol: string) => void
): Promise<BacktestResult> {
  const interval = params.interval ?? "1h";
  const tpPct = params.takeProfitPct ?? 30;
  const slPct = params.stopLossPct ?? 15;
  const leverage = params.leverage ?? 1;
  const marginMode = params.marginMode ?? "CROSS";
  const tpSlMode = params.tpSlMode ?? "PRICE";
  const fastPeriod = params.fastPeriod ?? 9;
  const slowPeriod = params.slowPeriod ?? 21;
  const mmr = params.maintenanceMarginRatePct ?? 0.5;
  const entryStates = resolveEntryStates(params);
  let fromMs = params.fromMs;
  let toMs = params.toMs;
  // Chỉ có `months` -> giới hạn N tháng cuối của dữ liệu local (trước đây bị bỏ qua).
  if (!fromMs && !toMs && params.months && params.months > 0) {
    const range = await getLocalDataRange();
    if (range) {
      toMs = range.maxTs;
      fromMs = range.maxTs - params.months * 30 * DAY_MS;
    }
  }
  const minCandles = Math.max(60, slowPeriod + 5);

  const useAlign = params.exitStrategy === "alignment";
  const simCfg: EmaSimCfg = {
    fastPeriod,
    slowPeriod,
    epsilonMode: params.epsilonMode,
    epsilonValue: params.epsilonValue,
    atrPeriod: params.atrPeriod,
    tpPct,
    slPct,
    leverage,
    marginMode,
    tpSlMode,
    entryStates,
    mmr,
  };
  const alignCfg: EmaAlignCfg = {
    fastPeriod,
    slowPeriod,
    epsilonMode: params.epsilonMode,
    epsilonValue: params.epsilonValue,
    atrPeriod: params.atrPeriod,
    entryStates,
    swingLookback: params.swingLookback ?? 10,
    emaBufferAtr: params.emaBufferAtr ?? 0.25,
    slAnchor: params.slAnchor ?? "protective",
    slAtrMult: params.slAtrMult ?? 1.5,
    globalExitOverlay: params.globalExitOverlay ?? true,
    hardExit: params.hardExit ?? true,
    leverage: params.leverage ?? 1,
    marginMode: params.marginMode ?? "CROSS",
    mmr,
  };

  const baseDir = env.DATA_1M_DIR;
  const files = fs.readdirSync(baseDir).filter((f) => f.toLowerCase().endsWith(".parquet"));
  const allEntries = files.map((f) => ({ file: path.join(baseDir, f), symbol: symbolFromFile(f) }));
  // SURVIVORSHIP/LOOK-AHEAD: xem chú thích ở runLocal1mBacktest — log symbol bị loại để audit.
  const droppedLowQ = allEntries.filter((e) => !isStableSymbol(e.symbol) && isLowQualitySymbol(e.symbol));
  if (droppedLowQ.length) {
    logger.info(
      "strategy",
      `EMA loại ${droppedLowQ.length} symbol dữ liệu xấu (flatline/chết, không point-in-time): ${droppedLowQ.map((e) => e.symbol).join(", ")}`
    );
  }
  let entries = allEntries
    .filter((e) => !isStableSymbol(e.symbol)) // bỏ stablecoin/fiat
    .filter((e) => !isLowQualitySymbol(e.symbol)); // bỏ coin dữ liệu xấu (flatline/chết)
  if (params.symbols && params.symbols.length) {
    const want = new Set(params.symbols.map((s) => s.toUpperCase()));
    entries = entries.filter((e) => want.has(e.symbol));
  }

  logger.info(
    "strategy",
    `Backtest EMA LOCAL: ${entries.length} file, khung ${interval}, EMA ${fastPeriod}/${slowPeriod}, states [${[...entryStates].join(",")}], exit=${useAlign ? "alignment" : "simple"}`
  );

  const allTrades: BacktestTrade[] = [];
  const perSymbol: SymbolResult[] = [];
  let minT = Infinity;
  let maxT = -Infinity;
  let done = 0;

  for (const e of entries) {
    try {
      let candles = await getResampledSeries(e.symbol, e.file, interval);
      if (fromMs && toMs) candles = candles.filter((k) => k.openTime >= fromMs && k.openTime < toMs);
      if (candles.length >= minCandles) {
        minT = Math.min(minT, candles[0].openTime);
        maxT = Math.max(maxT, candles[candles.length - 1].openTime);
        const trades = useAlign
          ? simulateSymbolEmaAlignment(e.symbol, candles, alignCfg)
          : simulateSymbolEma(e.symbol, candles, simCfg);
        perSymbol.push({
          symbol: e.symbol,
          candles: candles.length,
          trades: trades.length,
          wins: trades.filter((t) => t.pnlPct > 0).length,
          returnPct: trades.reduce((s, t) => s + t.pnlPct, 0),
        });
        allTrades.push(...trades);
      } else {
        perSymbol.push({ symbol: e.symbol, candles: candles.length, trades: 0, wins: 0, returnPct: 0 });
      }
    } catch (err) {
      logger.warn("strategy", `EMA đọc ${e.symbol} lỗi: ${String(err)}`);
      perSymbol.push({ symbol: e.symbol, candles: 0, trades: 0, wins: 0, returnPct: 0 });
    }
    done += 1;
    onProgress?.(done, entries.length, e.symbol);
    if (done % 8 === 0) await new Promise<void>((r) => setImmediate(r));
  }

  const sp: StrategyParams = {
    minDropPct: 0,
    minSidewayCandles: 0,
    maxSidewayRangePct: 0,
    minRisePct: 0,
  };
  return buildResult(allTrades, perSymbol, {
    params,
    sp,
    months: 0,
    interval,
    tpPct,
    slPct,
    startTime: isFinite(minT) ? minT : 0,
    endTime: isFinite(maxT) ? maxT : 0,
    symbols: entries.map((e) => e.symbol),
  });
}

// ===================== BACKTEST TREND FOLLOWING (Donchian breakout + regime) =====================

// Cặp regime↔alt: BTC1H_ALT1H (regime 1h → alt 1h) hoặc BTC1H_ALT15M (regime 1h → alt 15m).
export type RegimeMode = "BTC1H_ALT1H" | "BTC1H_ALT15M";

export interface TrendBacktestParams extends BacktestParams, TrendParams {
  useRegime?: boolean; // bật cổng regime BTC (mặc định true)
  regimeMode?: RegimeMode; // luôn BTC1H_ALT1H (giữ field cho tương thích payload)
  regimeSymbol?: string; // mặc định BTCUSDT
  regimeEmaPeriod?: number; // mặc định 200
  regimeSource?: "local" | "binance"; // nguồn nến regime: local /1m (mặc định) hay kéo Binance
  useRegimeSlope?: boolean; // regime đa tầng: yêu cầu EMA dốc đúng chiều
  regimeSlopeLookback?: number; // số nến đo độ dốc EMA (mặc định 20)
  useRegimeBreadth?: boolean; // regime đa tầng: yêu cầu breadth thị trường
  regimeBreadthMin?: number; // ngưỡng breadth cho LONG (mặc định 0.5)
  topLiquidity?: number; // CHỈ giữ N coin thanh khoản cao nhất (median $vol/ngày). 0 = tất cả. Bỏ qua nếu truyền `symbols`.
}

/** Cặp (khung regime BTC, khung nến alt). BTC1H_ALT15M → alt 15m; mặc định BTC 1h → alt 1h. */
export function resolveRegimeMode(mode?: RegimeMode): { regimeIv: string; altIv: string } {
  if (mode === "BTC1H_ALT15M") return { regimeIv: "1h", altIv: "15m" };
  return { regimeIv: "1h", altIv: "1h" };
}

/**
 * Backtest chiến lược TREND FOLLOWING trên DỮ LIỆU 1M LOCAL (parquet).
 * - Kéo BTC từ Binance (cache đĩa) để dựng regime filter (data local không có BTC).
 * - Resample 1m -> khung (mặc định 1h), chạy simulateSymbolTrend, dùng chung buildResult
 *   (phí + slippage + funding + trần danh mục + engine simulatePortfolio).
 * - Sizing khuyến nghị R-based: truyền riskPerTradePct (vd 0.5) + maxConcurrentPositions.
 */
export async function runTrendLocal1mBacktest(
  params: TrendBacktestParams,
  onProgress?: (done: number, total: number, symbol: string) => void
): Promise<BacktestResult> {
  // Khung nến alt được GHÉP theo regimeMode (BTC1H→alt15m, BTC4H→alt1h).
  const { regimeIv, altIv } = resolveRegimeMode(params.regimeMode);
  const interval = altIv;
  const cfg = resolveTrendCfg(params);

  let fromMs = params.fromMs;
  let toMs = params.toMs;
  const range = await getLocalDataRange();
  if (!fromMs && !toMs && params.months && params.months > 0 && range) {
    toMs = range.maxTs;
    fromMs = range.maxTs - params.months * 30 * DAY_MS;
  }
  // Mốc dùng để kéo regime BTC (nếu chưa có khoảng cụ thể -> toàn bộ range local).
  const regFrom = fromMs ?? range?.minTs ?? 0;
  const regTo = toMs ?? range?.maxTs ?? 0;
  let regimeAt: RegimeAt | undefined; // dựng sau khi có `entries` (breadth cần universe)

  const dir = env.DATA_1M_DIR;
  const files = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".parquet"));
  const allEntries = files.map((f) => ({ file: path.join(dir, f), symbol: symbolFromFile(f) }));
  const droppedLowQ = allEntries.filter((e) => !isStableSymbol(e.symbol) && isLowQualitySymbol(e.symbol));
  if (droppedLowQ.length) {
    logger.info(
      "strategy",
      `TREND loại ${droppedLowQ.length} symbol dữ liệu xấu: ${droppedLowQ.map((e) => e.symbol).join(", ")}`
    );
  }
  let entries = allEntries
    .filter((e) => !isStableSymbol(e.symbol))
    .filter((e) => !isLowQualitySymbol(e.symbol));
  if (params.symbols && params.symbols.length) {
    const want = new Set(params.symbols.map((s) => s.toUpperCase()));
    entries = entries.filter((e) => want.has(e.symbol));
  } else if ((params.topLiquidity ?? 0) > 0) {
    // LỌC THANH KHOẢN: chỉ giữ N coin có median $volume/ngày cao nhất (bỏ memecoin rác → breakout giả).
    const scored: { e: (typeof entries)[number]; liq: number }[] = [];
    for (const e of entries) {
      try {
        let d = await getResampledSeries(e.symbol, e.file, "1d");
        if (fromMs && toMs) d = d.filter((k) => k.openTime >= fromMs! && k.openTime < toMs!);
        if (d.length < 10) continue;
        const dv = d.map((k) => k.close * k.volume).sort((a, b) => a - b);
        scored.push({ e, liq: dv[Math.floor(dv.length / 2)] }); // median $vol/ngày
      } catch {
        /* bỏ qua */
      }
    }
    scored.sort((a, b) => b.liq - a.liq);
    entries = scored.slice(0, params.topLiquidity!).map((s) => s.e);
    logger.info("strategy", `Lọc thanh khoản: giữ top ${entries.length} coin (median $vol/ngày cao nhất)`);
  }

  // ---- Regime BTC theo 1 khung (1h hoặc 4h theo mode) + đa tầng slope/breadth ----
  if (params.useRegime !== false && regFrom && regTo) {
    const regSym = params.regimeSymbol ?? "BTCUSDT";
    const emaP = params.regimeEmaPeriod ?? 200;
    const source = params.regimeSource ?? "local";
    const step = regimeIv === "4h" ? 4 * 3_600_000 : 3_600_000;

    // Lấy nến BTC ở khung regime (local ưu tiên, fallback kéo Binance).
    const fetchIt = () => getRegimeKlines(regSym, regimeIv, regFrom - (emaP + 5) * step, regTo);
    let btc: Kline[] = [];
    if (source === "local") {
      btc = await getLocalSeriesForSymbol(regSym, regimeIv);
      if (btc.length < emaP + 2) btc = await fetchIt();
    } else {
      btc = await fetchIt();
      if (btc.length < emaP + 2) btc = await getLocalSeriesForSymbol(regSym, regimeIv);
    }

    // Breadth (tùy chọn) theo NGÀY — gate thị trường rộng.
    let breadthByDay: Map<number, number> | undefined;
    if (params.useRegimeBreadth) {
      const dailyU = new Map<string, Kline[]>();
      for (const e of entries) {
        try {
          const d = await getResampledSeries(e.symbol, e.file, "1d");
          if (d.length > emaP + 1) dailyU.set(e.symbol, d);
        } catch {
          /* bỏ qua */
        }
      }
      breadthByDay = computeBreadthByDay(dailyU, emaP);
    }

    if (btc.length >= emaP + 2) {
      const series = buildRegimeSeries(
        btc,
        {
          symbol: regSym,
          interval: regimeIv,
          emaPeriod: emaP,
          useSlope: params.useRegimeSlope,
          slopeLookback: params.regimeSlopeLookback ?? 20,
          useBreadth: params.useRegimeBreadth,
          breadthMin: params.regimeBreadthMin ?? 0.5,
        },
        breadthByDay
      );
      regimeAt = makeRegimeAt(series);
      logger.info(
        "strategy",
        `Regime ${regSym}/${regimeIv} → alt ${altIv}, nguồn=${source} (${btc.length} nến)${params.useRegimeSlope ? " +slope" : ""}${params.useRegimeBreadth ? " +breadth" : ""}`
      );
    } else {
      logger.warn("strategy", `Regime ${regSym}/${regimeIv}: không đủ nến -> chạy KHÔNG regime`);
    }
  }

  logger.info(
    "strategy",
    `Backtest TREND LOCAL: ${entries.length} file, khung ${interval}, DC ${cfg.dcEntry}/${cfg.dcExit}, ADX>${cfg.adxMin}, regime=${regimeAt ? (params.regimeSymbol ?? "BTCUSDT") : "OFF"}, short=${cfg.allowShort}`
  );

  const allTrades: BacktestTrade[] = [];
  const perSymbol: SymbolResult[] = [];
  const tradedSymbols = new Set<string>();
  let minT = Infinity;
  let maxT = -Infinity;
  let done = 0;
  const minCandles = Math.max(60, cfg.emaTrend + 5, cfg.dcEntry + 5);

  for (const e of entries) {
    try {
      let candles = await getResampledSeries(e.symbol, e.file, interval);
      if (fromMs && toMs) candles = candles.filter((k) => k.openTime >= fromMs! && k.openTime < toMs!);
      if (candles.length >= minCandles) {
        minT = Math.min(minT, candles[0].openTime);
        maxT = Math.max(maxT, candles[candles.length - 1].openTime);
        const trades = simulateSymbolTrend(e.symbol, candles, cfg, regimeAt, INTERVAL_MS[interval] ?? 0);
        // Mô hình thanh lý theo đòn bẩy (mặc định bật). Đòn bẩy cao -> vị thế bị thanh lý sớm.
        if (params.useLiquidation !== false && trades.length) {
          applyLiquidation(trades, params.leverage ?? 1, params.maintenanceMarginRatePct ?? 0.5);
        }
        if (params.useRealFunding && trades.length) {
          const rates = await getFundingCached(
            e.symbol,
            candles[0].openTime,
            candles[candles.length - 1].openTime
          );
          applyRealFunding(trades, rates);
        }
        perSymbol.push({
          symbol: e.symbol,
          candles: candles.length,
          trades: trades.length,
          wins: trades.filter((t) => t.pnlPct > 0).length,
          returnPct: trades.reduce((s, t) => s + t.pnlPct, 0),
        });
        if (trades.length) tradedSymbols.add(e.symbol);
        allTrades.push(...trades);
      } else {
        perSymbol.push({ symbol: e.symbol, candles: candles.length, trades: 0, wins: 0, returnPct: 0 });
      }
    } catch (err) {
      logger.warn("strategy", `TREND đọc ${e.symbol} lỗi: ${String(err)}`);
      perSymbol.push({ symbol: e.symbol, candles: 0, trades: 0, wins: 0, returnPct: 0 });
    }
    done += 1;
    onProgress?.(done, entries.length, e.symbol);
    if (done % 8 === 0) await new Promise<void>((r) => setImmediate(r));
  }

  // ---- Correlation cluster cap: gom cụm trên nến NGÀY của các symbol có giao dịch ----
  let clusterOf: Map<string, number> | undefined;
  if (params.useCorrelationCap && (params.maxPerCluster ?? 0) > 0 && tradedSymbols.size > 1) {
    const fileBySymbol = new Map(entries.map((e) => [e.symbol, e.file]));
    const dailyBySymbol = new Map<string, Kline[]>();
    for (const sym of tradedSymbols) {
      const file = fileBySymbol.get(sym);
      if (!file) continue;
      try {
        let d = await getResampledSeries(sym, file, "1d");
        if (fromMs && toMs) d = d.filter((k) => k.openTime >= fromMs! && k.openTime < toMs!);
        if (d.length > 5) dailyBySymbol.set(sym, d);
      } catch {
        /* bỏ qua */
      }
    }
    clusterOf = computeCorrelationClusters(dailyBySymbol, params.corrThreshold ?? 0.8);
    logger.info(
      "strategy",
      `Correlation cap: ${dailyBySymbol.size} symbol → ${clusterCount(clusterOf)} cụm (ngưỡng ${params.corrThreshold ?? 0.8}), trần ${params.maxPerCluster}/cụm`
    );
  }

  const spTrend: StrategyParams = { minDropPct: 0, minSidewayCandles: 0, maxSidewayRangePct: 0, minRisePct: 0 };
  return buildResult(allTrades, perSymbol, {
    params,
    sp: spTrend,
    months: 0,
    interval,
    tpPct: 0,
    slPct: 0,
    startTime: isFinite(minT) ? minT : 0,
    endTime: isFinite(maxT) ? maxT : 0,
    symbols: entries.map((e) => e.symbol),
    clusterOf,
    maxPerCluster: params.maxPerCluster,
  });
}

// ===================== ROUTER — Trend Following + Mean Reversion =====================

export interface RouterBacktestParams extends TrendBacktestParams {
  /** Override tham số mean-reversion. Kế thừa allowLong/allowShort của trend nếu không set riêng. */
  meanRev?: MeanRevParams;
  /** Tắt nhánh trend (chỉ mean-rev). Mặc định bật. */
  useTrend?: boolean;
  /** Tắt nhánh mean-rev (chỉ trend). Mặc định bật. */
  useMeanRev?: boolean;
}

/**
 * Backtest ROUTER: gộp 2 nhánh vào MỘT portfolio.
 *  - Nhánh TREND: simulateSymbolTrend — chỉ fire khi ADX > adxMin (thị trường có xu hướng).
 *  - Nhánh MEAN-REV: simulateSymbolMeanRev — chỉ fire khi RANGE (ADX ≤ adxMax & Choppiness ≥ chopMin).
 * Hai cổng ADX gần như loại trừ nhau → mỗi bối cảnh dùng chiến lược hợp lý. Trộn tất cả lệnh rồi
 * chạy chung simulatePortfolio (trần vị thế, DD breaker, correlation cap, daily/weekly limit).
 * Regime BTC + thanh lý áp cho CẢ HAI nhánh giống runTrendLocal1mBacktest.
 */
export async function runRouterLocal1mBacktest(
  params: RouterBacktestParams,
  onProgress?: (done: number, total: number, symbol: string) => void
): Promise<BacktestResult> {
  const { regimeIv, altIv } = resolveRegimeMode(params.regimeMode);
  const interval = altIv;
  const cfg = resolveTrendCfg(params);
  const mrCfg = resolveMeanRevCfg({
    allowLong: params.allowLong,
    allowShort: params.allowShort,
    ...params.meanRev,
  });
  const useTrend = params.useTrend !== false;
  const useMeanRev = params.useMeanRev !== false;

  let fromMs = params.fromMs;
  let toMs = params.toMs;
  const range = await getLocalDataRange();
  if (!fromMs && !toMs && params.months && params.months > 0 && range) {
    toMs = range.maxTs;
    fromMs = range.maxTs - params.months * 30 * DAY_MS;
  }
  const regFrom = fromMs ?? range?.minTs ?? 0;
  const regTo = toMs ?? range?.maxTs ?? 0;
  let regimeAt: RegimeAt | undefined;

  const dir = env.DATA_1M_DIR;
  const files = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".parquet"));
  const allEntries = files.map((f) => ({ file: path.join(dir, f), symbol: symbolFromFile(f) }));
  let entries = allEntries
    .filter((e) => !isStableSymbol(e.symbol))
    .filter((e) => !isLowQualitySymbol(e.symbol));
  if (params.symbols && params.symbols.length) {
    const want = new Set(params.symbols.map((s) => s.toUpperCase()));
    entries = entries.filter((e) => want.has(e.symbol));
  } else if ((params.topLiquidity ?? 0) > 0) {
    const scored: { e: (typeof entries)[number]; liq: number }[] = [];
    for (const e of entries) {
      try {
        let d = await getResampledSeries(e.symbol, e.file, "1d");
        if (fromMs && toMs) d = d.filter((k) => k.openTime >= fromMs! && k.openTime < toMs!);
        if (d.length < 10) continue;
        const dv = d.map((k) => k.close * k.volume).sort((a, b) => a - b);
        scored.push({ e, liq: dv[Math.floor(dv.length / 2)] });
      } catch {
        /* bỏ qua */
      }
    }
    scored.sort((a, b) => b.liq - a.liq);
    entries = scored.slice(0, params.topLiquidity!).map((s) => s.e);
  }

  // ---- Regime BTC (dùng chung cho cả trend & mean-rev) ----
  if (params.useRegime !== false && regFrom && regTo) {
    const regSym = params.regimeSymbol ?? "BTCUSDT";
    const emaP = params.regimeEmaPeriod ?? 200;
    const source = params.regimeSource ?? "local";
    const step = regimeIv === "4h" ? 4 * 3_600_000 : 3_600_000;
    const fetchIt = () => getRegimeKlines(regSym, regimeIv, regFrom - (emaP + 5) * step, regTo);
    let btc: Kline[] = [];
    if (source === "local") {
      btc = await getLocalSeriesForSymbol(regSym, regimeIv);
      if (btc.length < emaP + 2) btc = await fetchIt();
    } else {
      btc = await fetchIt();
      if (btc.length < emaP + 2) btc = await getLocalSeriesForSymbol(regSym, regimeIv);
    }
    let breadthByDay: Map<number, number> | undefined;
    if (params.useRegimeBreadth) {
      const dailyU = new Map<string, Kline[]>();
      for (const e of entries) {
        try {
          const d = await getResampledSeries(e.symbol, e.file, "1d");
          if (d.length > emaP + 1) dailyU.set(e.symbol, d);
        } catch {
          /* bỏ qua */
        }
      }
      breadthByDay = computeBreadthByDay(dailyU, emaP);
    }
    if (btc.length >= emaP + 2) {
      const series = buildRegimeSeries(
        btc,
        {
          symbol: regSym,
          interval: regimeIv,
          emaPeriod: emaP,
          useSlope: params.useRegimeSlope,
          slopeLookback: params.regimeSlopeLookback ?? 20,
          useBreadth: params.useRegimeBreadth,
          breadthMin: params.regimeBreadthMin ?? 0.5,
        },
        breadthByDay
      );
      regimeAt = makeRegimeAt(series);
    }
  }

  logger.info(
    "strategy",
    `Backtest ROUTER LOCAL: ${entries.length} file, khung ${interval}, trend=${useTrend ? `ADX>${cfg.adxMin}` : "OFF"}, meanRev=${useMeanRev ? `ADX≤${mrCfg.adxMax}&CI≥${mrCfg.chopMin}` : "OFF"}, regime=${regimeAt ? (params.regimeSymbol ?? "BTCUSDT") : "OFF"}, short=${cfg.allowShort}`
  );

  const allTrades: BacktestTrade[] = [];
  const perSymbol: SymbolResult[] = [];
  const tradedSymbols = new Set<string>();
  let minT = Infinity;
  let maxT = -Infinity;
  let done = 0;
  let nTrend = 0;
  let nMeanRev = 0;
  const barMs = INTERVAL_MS[interval] ?? 0;
  const minCandles = Math.max(60, cfg.emaTrend + 5, cfg.dcEntry + 5, mrCfg.n + 5);

  for (const e of entries) {
    try {
      let candles = await getResampledSeries(e.symbol, e.file, interval);
      if (fromMs && toMs) candles = candles.filter((k) => k.openTime >= fromMs! && k.openTime < toMs!);
      if (candles.length >= minCandles) {
        minT = Math.min(minT, candles[0].openTime);
        maxT = Math.max(maxT, candles[candles.length - 1].openTime);
        const symTrades: BacktestTrade[] = [];
        if (useTrend) {
          const t = simulateSymbolTrend(e.symbol, candles, cfg, regimeAt, barMs);
          nTrend += t.length;
          symTrades.push(...t);
        }
        if (useMeanRev) {
          const m = simulateSymbolMeanRev(e.symbol, candles, mrCfg, regimeAt);
          nMeanRev += m.length;
          symTrades.push(...m);
        }
        // Thanh lý theo đòn bẩy — áp cho cả hai nhánh (mặc định bật).
        if (params.useLiquidation !== false && symTrades.length) {
          applyLiquidation(symTrades, params.leverage ?? 1, params.maintenanceMarginRatePct ?? 0.5);
        }
        if (params.useRealFunding && symTrades.length) {
          const rates = await getFundingCached(e.symbol, candles[0].openTime, candles[candles.length - 1].openTime);
          applyRealFunding(symTrades, rates);
        }
        perSymbol.push({
          symbol: e.symbol,
          candles: candles.length,
          trades: symTrades.length,
          wins: symTrades.filter((t) => t.pnlPct > 0).length,
          returnPct: symTrades.reduce((s, t) => s + t.pnlPct, 0),
        });
        if (symTrades.length) tradedSymbols.add(e.symbol);
        allTrades.push(...symTrades);
      } else {
        perSymbol.push({ symbol: e.symbol, candles: candles.length, trades: 0, wins: 0, returnPct: 0 });
      }
    } catch (err) {
      logger.warn("strategy", `ROUTER đọc ${e.symbol} lỗi: ${String(err)}`);
      perSymbol.push({ symbol: e.symbol, candles: 0, trades: 0, wins: 0, returnPct: 0 });
    }
    done += 1;
    onProgress?.(done, entries.length, e.symbol);
    if (done % 8 === 0) await new Promise<void>((r) => setImmediate(r));
  }
  logger.info("strategy", `ROUTER lệnh thô: trend ${nTrend} + meanRev ${nMeanRev} = ${allTrades.length}`);

  // ---- Correlation cluster cap ----
  let clusterOf: Map<string, number> | undefined;
  if (params.useCorrelationCap && (params.maxPerCluster ?? 0) > 0 && tradedSymbols.size > 1) {
    const fileBySymbol = new Map(entries.map((e) => [e.symbol, e.file]));
    const dailyBySymbol = new Map<string, Kline[]>();
    for (const sym of tradedSymbols) {
      const file = fileBySymbol.get(sym);
      if (!file) continue;
      try {
        let d = await getResampledSeries(sym, file, "1d");
        if (fromMs && toMs) d = d.filter((k) => k.openTime >= fromMs! && k.openTime < toMs!);
        if (d.length > 5) dailyBySymbol.set(sym, d);
      } catch {
        /* bỏ qua */
      }
    }
    clusterOf = computeCorrelationClusters(dailyBySymbol, params.corrThreshold ?? 0.8);
  }

  const spRouter: StrategyParams = { minDropPct: 0, minSidewayCandles: 0, maxSidewayRangePct: 0, minRisePct: 0 };
  return buildResult(allTrades, perSymbol, {
    params,
    sp: spRouter,
    months: 0,
    interval,
    tpPct: 0,
    slPct: 0,
    startTime: isFinite(minT) ? minT : 0,
    endTime: isFinite(maxT) ? maxT : 0,
    symbols: entries.map((e) => e.symbol),
    clusterOf,
    maxPerCluster: params.maxPerCluster,
  });
}

// ===================== GRID SEARCH — tự tìm bộ tham số tốt nhất =====================

export interface TrendGridParams extends TrendBacktestParams {
  grid?: { dcEntry?: number[]; k1Atr?: number[]; k2Atr?: number[]; adxMin?: number[]; regimeEma?: number[] };
  minTrades?: number; // loại combo quá ít lệnh (chống overfit), mặc định 30
}

export interface GridRow {
  dcEntry: number;
  dcExit: number;
  k1Atr: number;
  k2Atr: number;
  adxMin: number;
  regimeEma: number; // EMA regime BTC của combo
  trades: number;
  winRate: number;
  roiPct: number;
  maxDrawdownPct: number;
  sharpe: number | null;
  cagr: number;
  calmar: number | null;
  profitFactor: number;
  expectancyR: number;
  accountBlown: boolean;
  score: number; // = CAGR/MaxDD (Calmar); loại (−∞) nếu cháy / thiếu lệnh
}

export interface GridResult {
  combos: number;
  regimeMode: RegimeMode;
  altInterval: string;
  minTrades: number;
  best: GridRow | null;
  ranked: GridRow[];
}

/**
 * Quét lưới tham số TREND (dcEntry × k1 × k2 × adxMin), xếp hạng theo Calmar (CAGR/MaxDD).
 * TẮT risk-overlay (DD breaker + correlation cap) khi quét để đo EDGE thô của bộ tín hiệu/exit;
 * áp overlay sau khi chọn được bộ. dcExit = round(dcEntry/2).
 */
export async function runTrendGrid(
  params: TrendGridParams,
  onProgress?: (done: number, total: number, label: string) => void
): Promise<GridResult> {
  const g = {
    dcEntry: params.grid?.dcEntry ?? [50, 100, 150],
    k1Atr: params.grid?.k1Atr ?? [2, 2.5, 3],
    k2Atr: params.grid?.k2Atr ?? [3, 4.5, 6],
    adxMin: params.grid?.adxMin ?? [20, 25],
    regimeEma: params.grid?.regimeEma ?? [params.regimeEmaPeriod ?? 200], // mặc định KHÔNG quét (giữ 1 giá trị)
  };
  const minTrades = params.minTrades ?? 30;
  const { altIv, regimeIv } = resolveRegimeMode(params.regimeMode);

  const combos: { dcEntry: number; dcExit: number; k1Atr: number; k2Atr: number; adxMin: number; regimeEma: number }[] = [];
  for (const dcEntry of g.dcEntry)
    for (const k1Atr of g.k1Atr)
      for (const k2Atr of g.k2Atr)
        for (const adxMin of g.adxMin)
          for (const regimeEma of g.regimeEma)
            combos.push({ dcEntry, dcExit: Math.max(10, Math.round(dcEntry / 2)), k1Atr, k2Atr, adxMin, regimeEma });

  logger.info("strategy", `Grid TREND: ${combos.length} tổ hợp, alt ${altIv} + regime BTC ${regimeIv} (EMA ${g.regimeEma.join("/")}), minTrades ${minTrades}`);
  const rows: GridRow[] = [];
  let done = 0;
  for (const c of combos) {
    const r = await runTrendLocal1mBacktest({
      ...params,
      dcEntry: c.dcEntry,
      dcExit: c.dcExit,
      k1Atr: c.k1Atr,
      k2Atr: c.k2Atr,
      adxMin: c.adxMin,
      regimeEmaPeriod: c.regimeEma, // tối ưu EMA regime BTC
      // Tắt overlay khi quét để đo edge thô
      useCorrelationCap: false,
      maxPerCluster: 0,
      ddHaltPct: 0,
      ddReducePct: 0,
    });
    const score = r.accountBlown || r.totalTrades < minTrades
      ? -1e9
      : r.maxDrawdownPct > 0 ? r.cagr / r.maxDrawdownPct : r.cagr;
    rows.push({
      ...c,
      trades: r.totalTrades,
      winRate: Number(r.winRate.toFixed(1)),
      roiPct: r.roiPct,
      maxDrawdownPct: r.maxDrawdownPct,
      sharpe: r.sharpe,
      cagr: r.cagr,
      calmar: r.calmar,
      profitFactor: r.profitFactor,
      expectancyR: r.expectancyR,
      accountBlown: r.accountBlown,
      score: Number(score.toFixed(4)),
    });
    done += 1;
    onProgress?.(done, combos.length, `DC${c.dcEntry} k1=${c.k1Atr} k2=${c.k2Atr} ADX>${c.adxMin} emaBTC${c.regimeEma}`);
  }

  rows.sort((a, b) => b.score - a.score || (b.sharpe ?? -9) - (a.sharpe ?? -9) || b.roiPct - a.roiPct);
  return {
    combos: combos.length,
    regimeMode: params.regimeMode ?? "BTC1H_ALT1H",
    altInterval: altIv,
    minTrades,
    best: rows[0] ?? null,
    ranked: rows.slice(0, 25),
  };
}

// ===================== MEAN REVERSION (local backtest + grid) =====================

export interface MeanRevBacktestParams extends BacktestParams, MeanRevParams {
  useRegime?: boolean;
  regimeMode?: RegimeMode;
  regimeSymbol?: string;
  regimeEmaPeriod?: number;
  regimeSource?: "local" | "binance";
  topLiquidity?: number;
}

/** Backtest MEAN REVERSION trên dữ liệu 1m local — dùng chung regime/topLiquidity/buildResult như TREND. */
export async function runMeanRevLocal1mBacktest(
  params: MeanRevBacktestParams,
  onProgress?: (done: number, total: number, symbol: string) => void
): Promise<BacktestResult> {
  const { regimeIv, altIv } = resolveRegimeMode(params.regimeMode);
  const interval = altIv;
  const cfg = resolveMeanRevCfg(params);

  let fromMs = params.fromMs;
  let toMs = params.toMs;
  const range = await getLocalDataRange();
  if (!fromMs && !toMs && params.months && params.months > 0 && range) {
    toMs = range.maxTs;
    fromMs = range.maxTs - params.months * 30 * DAY_MS;
  }
  const regFrom = fromMs ?? range?.minTs ?? 0;
  const regTo = toMs ?? range?.maxTs ?? 0;

  const dir = env.DATA_1M_DIR;
  const files = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".parquet"));
  const allEntries = files.map((f) => ({ file: path.join(dir, f), symbol: symbolFromFile(f) }));
  let entries = allEntries
    .filter((e) => !isStableSymbol(e.symbol))
    .filter((e) => !isLowQualitySymbol(e.symbol));
  if (params.symbols && params.symbols.length) {
    const want = new Set(params.symbols.map((s) => s.toUpperCase()));
    entries = entries.filter((e) => want.has(e.symbol));
  } else if ((params.topLiquidity ?? 0) > 0) {
    const scored: { e: (typeof entries)[number]; liq: number }[] = [];
    for (const e of entries) {
      try {
        let d = await getResampledSeries(e.symbol, e.file, "1d");
        if (fromMs && toMs) d = d.filter((k) => k.openTime >= fromMs! && k.openTime < toMs!);
        if (d.length < 10) continue;
        const dv = d.map((k) => k.close * k.volume).sort((a, b) => a - b);
        scored.push({ e, liq: dv[Math.floor(dv.length / 2)] });
      } catch { /* bỏ qua */ }
    }
    scored.sort((a, b) => b.liq - a.liq);
    entries = scored.slice(0, params.topLiquidity!).map((s) => s.e);
  }

  // Regime BTC (cùng cơ chế TREND) — dùng để CHẶN fade ngược trend BTC mạnh.
  let regimeAt: RegimeAt | undefined;
  if (params.useRegime !== false && regFrom && regTo) {
    const regSym = params.regimeSymbol ?? "BTCUSDT";
    const emaP = params.regimeEmaPeriod ?? 200;
    const source = params.regimeSource ?? "local";
    const step = regimeIv === "4h" ? 4 * 3_600_000 : 3_600_000;
    let btc: Kline[] = source === "local" ? await getLocalSeriesForSymbol(regSym, regimeIv) : [];
    if (btc.length < emaP + 2) btc = await getRegimeKlines(regSym, regimeIv, regFrom - (emaP + 5) * step, regTo);
    if (btc.length >= emaP + 2) {
      const series = buildRegimeSeries(btc, { symbol: regSym, interval: regimeIv, emaPeriod: emaP });
      regimeAt = makeRegimeAt(series);
    }
  }

  logger.info(
    "strategy",
    `Backtest MEANREV LOCAL: ${entries.length} coin, alt ${interval}, z≥${cfg.zEntry} RSI ${cfg.rsiLow}/${cfg.rsiHigh} ADX≤${cfg.adxMax} CI≥${cfg.chopMin}, regime=${regimeAt ? "ON" : "OFF"}`
  );

  const allTrades: BacktestTrade[] = [];
  const perSymbol: SymbolResult[] = [];
  let minT = Infinity;
  let maxT = -Infinity;
  let done = 0;
  const minCandles = Math.max(60, cfg.n + 5);

  for (const e of entries) {
    try {
      let candles = await getResampledSeries(e.symbol, e.file, interval);
      if (fromMs && toMs) candles = candles.filter((k) => k.openTime >= fromMs! && k.openTime < toMs!);
      if (candles.length >= minCandles) {
        minT = Math.min(minT, candles[0].openTime);
        maxT = Math.max(maxT, candles[candles.length - 1].openTime);
        const trades = simulateSymbolMeanRev(e.symbol, candles, cfg, regimeAt);
        if (params.useRealFunding && trades.length) {
          const rates = await getFundingCached(e.symbol, candles[0].openTime, candles[candles.length - 1].openTime);
          applyRealFunding(trades, rates);
        }
        perSymbol.push({
          symbol: e.symbol,
          candles: candles.length,
          trades: trades.length,
          wins: trades.filter((t) => t.pnlPct > 0).length,
          returnPct: trades.reduce((s, t) => s + t.pnlPct, 0),
        });
        allTrades.push(...trades);
      } else {
        perSymbol.push({ symbol: e.symbol, candles: candles.length, trades: 0, wins: 0, returnPct: 0 });
      }
    } catch (err) {
      logger.warn("strategy", `MEANREV đọc ${e.symbol} lỗi: ${String(err)}`);
    }
    done += 1;
    onProgress?.(done, entries.length, e.symbol);
    if (done % 8 === 0) await new Promise<void>((r) => setImmediate(r));
  }

  // Correlation cluster cap (tùy chọn) — như TREND
  let clusterOf: Map<string, number> | undefined;
  const traded = new Set(allTrades.map((t) => t.symbol));
  if (params.useCorrelationCap && (params.maxPerCluster ?? 0) > 0 && traded.size > 1) {
    const fileBySymbol = new Map(entries.map((e) => [e.symbol, e.file]));
    const dailyBySymbol = new Map<string, Kline[]>();
    for (const sym of traded) {
      const file = fileBySymbol.get(sym);
      if (!file) continue;
      try {
        let d = await getResampledSeries(sym, file, "1d");
        if (fromMs && toMs) d = d.filter((k) => k.openTime >= fromMs! && k.openTime < toMs!);
        if (d.length > 5) dailyBySymbol.set(sym, d);
      } catch { /* bỏ qua */ }
    }
    clusterOf = computeCorrelationClusters(dailyBySymbol, params.corrThreshold ?? 0.8);
  }

  const spMr: StrategyParams = { minDropPct: 0, minSidewayCandles: 0, maxSidewayRangePct: 0, minRisePct: 0 };
  return buildResult(allTrades, perSymbol, {
    params,
    sp: spMr,
    months: 0,
    interval,
    tpPct: 0,
    slPct: 0,
    startTime: isFinite(minT) ? minT : 0,
    endTime: isFinite(maxT) ? maxT : 0,
    symbols: entries.map((e) => e.symbol),
    clusterOf,
    maxPerCluster: params.maxPerCluster,
  });
}

export interface MeanRevGridParams extends MeanRevBacktestParams {
  grid?: { n?: number[]; zEntry?: number[]; zStop?: number[]; timeStopBars?: number[]; adxMax?: number[] };
  minTrades?: number;
}
export interface MeanRevGridRow {
  n: number;
  zEntry: number;
  zStop: number;
  timeStopBars: number;
  adxMax: number;
  trades: number;
  winRate: number;
  roiPct: number;
  maxDrawdownPct: number;
  sharpe: number | null;
  cagr: number;
  calmar: number | null;
  profitFactor: number;
  expectancyR: number;
  accountBlown: boolean;
  score: number;
}
export interface MeanRevGridResult {
  combos: number;
  altInterval: string;
  minTrades: number;
  best: MeanRevGridRow | null;
  ranked: MeanRevGridRow[];
}

/** Grid search MEAN REVERSION: n × zEntry × zStop × timeStop × adxMax, xếp theo Calmar. */
export async function runMeanRevGrid(
  params: MeanRevGridParams,
  onProgress?: (done: number, total: number, label: string) => void
): Promise<MeanRevGridResult> {
  const g = {
    n: params.grid?.n ?? [50, 100, 150],
    zEntry: params.grid?.zEntry ?? [2.0, 2.5, 3.0],
    zStop: params.grid?.zStop ?? [3.5, 4.5],
    timeStopBars: params.grid?.timeStopBars ?? [24, 48, 96],
    adxMax: params.grid?.adxMax ?? [25],
  };
  const minTrades = params.minTrades ?? 30;
  const { altIv } = resolveRegimeMode(params.regimeMode);
  const combos: { n: number; zEntry: number; zStop: number; timeStopBars: number; adxMax: number }[] = [];
  for (const n of g.n)
    for (const zEntry of g.zEntry)
      for (const zStop of g.zStop)
        for (const timeStopBars of g.timeStopBars)
          for (const adxMax of g.adxMax)
            combos.push({ n, zEntry, zStop, timeStopBars, adxMax });

  logger.info("strategy", `Grid MEANREV: ${combos.length} tổ hợp, alt ${altIv}, minTrades ${minTrades}`);
  const rows: MeanRevGridRow[] = [];
  let done = 0;
  for (const c of combos) {
    const r = await runMeanRevLocal1mBacktest({
      ...params,
      n: c.n,
      zEntry: c.zEntry,
      zStop: c.zStop,
      timeStopBars: c.timeStopBars,
      adxMax: c.adxMax,
      useCorrelationCap: false,
      maxPerCluster: 0,
      ddHaltPct: 0,
      ddReducePct: 0,
    });
    const score = r.accountBlown || r.totalTrades < minTrades ? -1e9 : r.maxDrawdownPct > 0 ? r.cagr / r.maxDrawdownPct : r.cagr;
    rows.push({
      ...c,
      trades: r.totalTrades,
      winRate: Number(r.winRate.toFixed(1)),
      roiPct: r.roiPct,
      maxDrawdownPct: r.maxDrawdownPct,
      sharpe: r.sharpe,
      cagr: r.cagr,
      calmar: r.calmar,
      profitFactor: r.profitFactor,
      expectancyR: r.expectancyR,
      accountBlown: r.accountBlown,
      score: Number(score.toFixed(4)),
    });
    done += 1;
    onProgress?.(done, combos.length, `n${c.n} z${c.zEntry} zStop${c.zStop} TS${c.timeStopBars} ADX≤${c.adxMax}`);
  }
  rows.sort((a, b) => b.score - a.score || (b.sharpe ?? -9) - (a.sharpe ?? -9) || b.roiPct - a.roiPct);
  return { combos: combos.length, altInterval: altIv, minTrades, best: rows[0] ?? null, ranked: rows.slice(0, 25) };
}
