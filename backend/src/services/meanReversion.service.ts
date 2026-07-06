import { Kline } from "../lib/binance";
import type { BacktestTrade } from "./backtest.service";
import type { RegimeAt, RegimeSide } from "./trend.service";
import {
  zscoreSeries,
  choppinessSeries,
  rsiSeries,
  smaSeries,
  atrSeries,
  adxSeries,
} from "./indicators";

/**
 * CHIẾN LƯỢC MEAN REVERSION — fade z-score cực trị trong regime RANGE.
 * Xem docs/strategy/mean-reversion-v1.md.
 *
 * Vào LONG (oversold): regime range (ADX≤adxMax & CI≥chopMin) + z≤−zEntry + RSI≤rsiLow
 *   + close≤bbLo + volume≥volSpike×SMA + (regime BTC không downtrend mạnh).
 * Thoát: TP về fair value (z→0) SCALE-OUT (chốt 1 phần tại z≈−zPartial, phần còn lại tại z≈−zTp);
 *   z-stop (z≤−zStop = luận điểm sai); hard SL cấu trúc+ATR; time-stop.
 * SHORT đối xứng.
 */

export interface MeanRevParams {
  n?: number; // cửa sổ SMA/std cho z (mặc định 100)
  zEntry?: number; // ngưỡng vào |z| (2.2)
  zPartial?: number; // chốt 1 phần khi |z| về mức này (1.0)
  zTp?: number; // chốt hết khi |z| về mức này ~ mean (0.0)
  zStop?: number; // z-stop: |z| vượt mức này → luận điểm sai (3.8)
  kSl?: number; // hard stop = entry ∓ kSl·ATR (1.5)
  timeStopBars?: number; // thoát nếu chưa hồi sau N nến (48)
  rsiPeriod?: number; // 14
  rsiLow?: number; // 25
  rsiHigh?: number; // 75
  adxPeriod?: number; // 14
  adxMax?: number; // regime range yêu cầu ADX ≤ (30)
  chopPeriod?: number; // 14
  chopMin?: number; // regime range yêu cầu Choppiness ≥ (50)
  regimeLag?: number; // đo ADX/CI ở bar TRƯỚC cú lệch (ngữ cảnh range dẫn tới spike). Mặc định 3.
  atrPeriod?: number; // 14
  atrPctMin?: number; // 0.4
  atrPctMax?: number; // 6
  volSpike?: number; // volume ≥ volSpike × SMA20(vol) (2.0). 0 = tắt lọc volume
  bbMult?: number; // dải Bollinger = SMA ± bbMult·std (dùng cho điều kiện close≤bbLo). Mặc định = zEntry
  swingLookback?: number; // số nến tìm swing cho SL (10)
  allowLong?: boolean;
  allowShort?: boolean;
  useRegimeExit?: boolean; // đóng khi BTC lật trend mạnh ngược chiều (mặc định true)
}

export type MeanRevCfg = Required<Omit<MeanRevParams, "bbMult">> & { bbMult: number };

// Defaults hiệu chỉnh theo backtest (2023-24): chốt SỚM (zTp=-1, không giữ tới mean) cho win-rate/PF cao;
// TẮT lọc volume-spike (làm tệ hơn trong BT — climax là yếu tố LIVE); z2.0 + RSI30/70 để đủ tín hiệu.
export const MEANREV_DEFAULTS: MeanRevCfg = {
  n: 100,
  zEntry: 2.0,
  zPartial: 1.5,
  zTp: -1.0,
  zStop: 3.8,
  kSl: 1.5,
  timeStopBars: 48,
  rsiPeriod: 14,
  rsiLow: 30,
  rsiHigh: 70,
  adxPeriod: 14,
  adxMax: 30,
  chopPeriod: 14,
  chopMin: 50,
  regimeLag: 3,
  atrPeriod: 14,
  atrPctMin: 0.4,
  atrPctMax: 6,
  volSpike: 0,
  bbMult: 2.0,
  swingLookback: 10,
  allowLong: true,
  allowShort: true,
  useRegimeExit: true,
};

export function resolveMeanRevCfg(p: MeanRevParams = {}): MeanRevCfg {
  const merged = { ...MEANREV_DEFAULTS, ...p };
  if (p.bbMult === undefined) merged.bbMult = merged.zEntry; // mặc định band = ngưỡng z
  return merged;
}

/** Tín hiệu MR ở nến mới nhất (cho bot live). */
export interface MeanRevEntry {
  side: "LONG" | "SHORT";
  entry: number;
  stop: number;
  atr: number;
  z: number;
  rsi: number;
  reason: string;
}

function computeSeries(klines: Kline[], cfg: MeanRevCfg) {
  const close = klines.map((k) => k.close);
  const vol = klines.map((k) => k.volume);
  const { z, mean, std } = zscoreSeries(close, cfg.n);
  return {
    close,
    z,
    mean,
    std,
    rsi: rsiSeries(close, cfg.rsiPeriod),
    atr: atrSeries(klines, cfg.atrPeriod),
    adx: adxSeries(klines, cfg.adxPeriod),
    chop: choppinessSeries(klines, cfg.chopPeriod),
    volSma: smaSeries(vol, 20),
  };
}

/** Điều kiện regime + tín hiệu ở index i. Trả 'LONG'|'SHORT'|null. */
function signalAt(
  klines: Kline[],
  s: ReturnType<typeof computeSeries>,
  i: number,
  cfg: MeanRevCfg,
  regimeSide: RegimeSide | undefined
): "LONG" | "SHORT" | null {
  const finite =
    Number.isFinite(s.z[i]) && Number.isFinite(s.rsi[i]) && Number.isFinite(s.atr[i]) &&
    Number.isFinite(s.adx[i]) && Number.isFinite(s.chop[i]) && Number.isFinite(s.std[i]);
  if (!finite) return null;
  const c = klines[i];
  const atrPct = (s.atr[i] / c.close) * 100;
  if (atrPct < cfg.atrPctMin || atrPct > cfg.atrPctMax) return null;
  // Regime RANGE đo ở bar TRƯỚC cú lệch (regimeLag) — cú spike làm ADX vọt/CI tụt ở chính bar tín hiệu,
  // nên xét NGỮ CẢNH trước đó: thị trường đang range → mới fade cú lệch ra khỏi range.
  const r = Math.max(0, i - cfg.regimeLag);
  if (!Number.isFinite(s.adx[r]) || !Number.isFinite(s.chop[r])) return null;
  if (s.adx[r] > cfg.adxMax || s.chop[r] < cfg.chopMin) return null;
  // Volume climax (nếu bật)
  if (cfg.volSpike > 0 && Number.isFinite(s.volSma[i]) && c.volume < cfg.volSpike * s.volSma[i]) return null;

  const bbLo = s.mean[i] - cfg.bbMult * s.std[i];
  const bbUp = s.mean[i] + cfg.bbMult * s.std[i];
  // Cổng BTC: chỉ long khi BTC không SHORT (downtrend) mạnh; short khi không LONG mạnh.
  const btcAllowLong = !regimeSide || regimeSide !== "SHORT";
  const btcAllowShort = !regimeSide || regimeSide !== "LONG";

  const longOk =
    cfg.allowLong && btcAllowLong && s.z[i] <= -cfg.zEntry && s.rsi[i] <= cfg.rsiLow && c.close <= bbLo;
  const shortOk =
    cfg.allowShort && btcAllowShort && s.z[i] >= cfg.zEntry && s.rsi[i] >= cfg.rsiHigh && c.close >= bbUp;
  if (longOk) return "LONG";
  if (shortOk) return "SHORT";
  return null;
}

function swingLow(klines: Kline[], end: number, look: number): number {
  let lo = Infinity;
  for (let k = Math.max(0, end - look); k <= end; k++) lo = Math.min(lo, klines[k].low);
  return Number.isFinite(lo) ? lo : klines[end].low;
}
function swingHigh(klines: Kline[], end: number, look: number): number {
  let hi = -Infinity;
  for (let k = Math.max(0, end - look); k <= end; k++) hi = Math.max(hi, klines[k].high);
  return Number.isFinite(hi) ? hi : klines[end].high;
}

/** Tín hiệu MR ở nến MỚI NHẤT (live/paper). */
export function detectMeanRevEntry(
  klines: Kline[],
  cfg: MeanRevCfg,
  regimeSide?: RegimeSide
): MeanRevEntry | null {
  const n = klines.length;
  if (n < cfg.n + 5) return null;
  const s = computeSeries(klines, cfg);
  const i = n - 1;
  const side = signalAt(klines, s, i, cfg, regimeSide);
  if (!side) return null;
  const entry = klines[i].close;
  const atr = s.atr[i];
  const stop =
    side === "LONG"
      ? Math.min(swingLow(klines, i, cfg.swingLookback), entry - cfg.kSl * atr)
      : Math.max(swingHigh(klines, i, cfg.swingLookback), entry + cfg.kSl * atr);
  return {
    side,
    entry,
    stop,
    atr,
    z: s.z[i],
    rsi: s.rsi[i],
    reason: `${side} MR z=${s.z[i].toFixed(2)} RSI=${s.rsi[i].toFixed(0)} CI=${s.chop[i].toFixed(0)} ADX=${s.adx[i].toFixed(0)}`,
  };
}

/**
 * Mô phỏng toàn bộ trade MR cho 1 symbol. Không chồng lệnh. Fill tại close nến tín hiệu.
 * Thoát: hard SL / z-stop / partial-at-zPartial + TP-at-mean / time-stop / regime-flip.
 */
export function simulateSymbolMeanRev(
  symbol: string,
  klines: Kline[],
  cfg: MeanRevCfg,
  regimeAt?: RegimeAt
): BacktestTrade[] {
  const trades: BacktestTrade[] = [];
  const n = klines.length;
  if (n < cfg.n + 5) return trades;
  const s = computeSeries(klines, cfg);

  let i = 1;
  while (i < n) {
    const regime = regimeAt ? regimeAt(klines[i].openTime) : undefined;
    const side = signalAt(klines, s, i, cfg, regime);
    if (!side) {
      i++;
      continue;
    }
    const long = side === "LONG";
    const entry = klines[i].close;
    const atr = s.atr[i];
    const hardStop = long
      ? Math.min(swingLow(klines, i, cfg.swingLookback), entry - cfg.kSl * atr)
      : Math.max(swingHigh(klines, i, cfg.swingLookback), entry + cfg.kSl * atr);
    const riskDist = Math.abs(entry - hardStop);
    if (riskDist <= 0) {
      i++;
      continue;
    }
    const riskPctPrice = (riskDist / entry) * 100;
    const legPnl = (px: number) => (long ? ((px - entry) / entry) * 100 : ((entry - px) / entry) * 100);

    let remaining = 1.0;
    let realizedPnlPct = 0;
    let partialDone = false;
    let curStop = hardStop;
    let exitIdx = -1;
    let reason: BacktestTrade["reason"] = "EOD";
    let worstAdvPct = 0, worstAdvTime = klines[i].openTime;
    let bestFavPct = 0, bestFavTime = klines[i].openTime;

    for (let j = i + 1; j < n; j++) {
      const k = klines[j];
      const advPnl = legPnl(long ? k.low : k.high);
      if (advPnl < worstAdvPct) { worstAdvPct = advPnl; worstAdvTime = k.openTime; }
      const favPnl = legPnl(long ? k.high : k.low);
      if (favPnl > bestFavPct) { bestFavPct = favPnl; bestFavTime = k.openTime; }

      // (1) Hard stop (bi quan, gap→open)
      const hitStop = long ? k.low <= curStop : k.high >= curStop;
      if (hitStop) {
        const gapped = long ? k.open < curStop : k.open > curStop;
        realizedPnlPct += remaining * legPnl(gapped ? k.open : curStop);
        reason = curStop === hardStop ? "SL" : "TRAIL"; // TRAIL = đã dời hòa vốn
        exitIdx = j;
        break;
      }
      const zj = s.z[j];
      if (Number.isFinite(zj)) {
        // (2) z-stop: lệch sâu hơn nữa → luận điểm sai
        if ((long && zj <= -cfg.zStop) || (!long && zj >= cfg.zStop)) {
          realizedPnlPct += remaining * legPnl(k.close);
          reason = "SL";
          exitIdx = j;
          break;
        }
        // (3) Chốt 1 phần khi hồi tới zPartial (nửa đường về mean)
        if (!partialDone && (long ? zj >= -cfg.zPartial : zj <= cfg.zPartial)) {
          realizedPnlPct += 0.5 * legPnl(k.close);
          remaining -= 0.5;
          partialDone = true;
          curStop = entry; // dời hòa vốn
        }
        // (4) TP tại fair value (z→0)
        if ((long ? zj >= -cfg.zTp : zj <= cfg.zTp)) {
          realizedPnlPct += remaining * legPnl(k.close);
          reason = "TP";
          exitIdx = j;
          break;
        }
      }
      // (5) Regime flip mạnh ngược chiều
      if (cfg.useRegimeExit && regimeAt) {
        const rg = regimeAt(k.openTime);
        if ((long && rg === "SHORT") || (!long && rg === "LONG")) {
          realizedPnlPct += remaining * legPnl(k.close);
          reason = "FLIP";
          exitIdx = j;
          break;
        }
      }
      // (6) Time stop
      if (j - i >= cfg.timeStopBars) {
        realizedPnlPct += remaining * legPnl(k.close);
        reason = "EOD";
        exitIdx = j;
        break;
      }
    }
    if (exitIdx === -1) {
      realizedPnlPct += remaining * legPnl(klines[n - 1].close);
      reason = partialDone ? "TP" : "EOD";
      exitIdx = n - 1;
    }

    const effExit = long ? entry * (1 + realizedPnlPct / 100) : entry * (1 - realizedPnlPct / 100);
    trades.push({
      symbol,
      side,
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
      probability: Math.min(100, Math.round(Math.abs(s.z[i]) * 25)), // |z| lớn → "điểm" cao
      riskPctPrice,
      alignment: "REVERSAL",
    });
    i = exitIdx + 1;
  }
  return trades;
}
