import { Kline } from "../lib/binance";
import type { BacktestTrade } from "./backtest.service";
import {
  emaSeries,
  atrSeries,
  adxSeries,
  donchianHighSeries,
  donchianLowSeries,
  smaSeries,
} from "./indicators";

/**
 * ENTRY SCORE 0–100 (Phase 1): chấm chất lượng điểm vào lệnh từ các yếu tố có sẵn.
 *  - Sức mạnh trend (ADX 15→35 = 0→1)         · 30đ
 *  - Xác nhận volume (vol/SMA 0.8→2.0 = 0→1)   · 35đ  ← cắt fake breakout
 *  - Chất lượng breakout (khoảng cách vượt kênh theo ATR, 0→1.5·ATR) · 25đ
 *  - Vol band ở vùng "khỏe" (ATR% gần giữa dải) · 10đ
 */
function entryScore(
  long: boolean, adx: number, volRatio: number, brkAtr: number, atrPct: number,
  atrPctMin: number, atrPctMax: number
): number {
  const cl = (x: number) => Math.max(0, Math.min(1, x));
  const sAdx = cl((adx - 15) / 20);
  const sVol = cl((volRatio - 0.8) / 1.2);
  const sBrk = cl(brkAtr / 1.5);
  const mid = (atrPctMin + atrPctMax) / 2;
  const sBand = 1 - cl(Math.abs(atrPct - mid) / (atrPctMax - atrPctMin || 1));
  return 30 * sAdx + 35 * sVol + 25 * sBrk + 10 * sBand;
}

/**
 * CHIẾN LƯỢC TREND FOLLOWING — Multi-Timeframe Donchian Breakout.
 * Xem docs/strategy/trend-following-v1.md.
 *
 * Vào lệnh (LONG breakout):
 *   regime cho phép LONG
 *   AND close > EMA_TREND (giá trên trend nền)
 *   AND EMA_FAST > EMA_SLOW (cấu trúc tăng)
 *   AND ADX > adxMin (trend đủ mạnh, bỏ chop)
 *   AND close > DonchianHigh(dcEntry) (breakout đỉnh kênh)
 *   AND atrPct ∈ [atrPctMin, atrPctMax] (vol không chết / không điên)
 * SHORT đối xứng (chỉ khi allowShort).
 *
 * Thoát (hit-first):
 *   - Hard stop  = entry ∓ k1·ATR (cố định tại entry) — định nghĩa 1R.
 *   - Chandelier = HH − k2·ATR (LONG) / LL + k2·ATR (SHORT) — trailing, ratchet.
 *     Stop hiệu lực = XA hơn giữa hard stop & chandelier (chandelier chỉ siết KHI có lời).
 *   - Donchian exit = thủng DonchianLow(dcExit) (LONG) / vượt High(dcExit) (SHORT).
 *   - Time stop = giữ ≥ timeStopBars mà lãi < 0.5R -> đóng.
 *   - Regime flip (tùy chọn) = regime lật ngược -> đóng.
 */

export interface TrendParams {
  dcEntry?: number; // Donchian entry lookback (mặc định 100)
  dcExit?: number; // Donchian exit lookback (mặc định 50)
  emaFast?: number; // mặc định 20
  emaSlow?: number; // mặc định 50
  emaTrend?: number; // mặc định 200
  adxPeriod?: number; // mặc định 14
  adxMin?: number; // mặc định 25
  atrPeriod?: number; // mặc định 14
  k1Atr?: number; // hệ số hard stop (mặc định 2.5)
  k2Atr?: number; // hệ số chandelier trail (mặc định 3.0)
  timeStopBars?: number; // số nến time-stop (mặc định 240 ≈ 10 ngày @1h)
  atrPctMin?: number; // % ATR/giá tối thiểu (mặc định 0.5)
  atrPctMax?: number; // % ATR/giá tối đa (mặc định 8)
  allowLong?: boolean; // mặc định true
  allowShort?: boolean; // mặc định false (alt short nguy hiểm)
  useRegimeExit?: boolean; // đóng khi regime lật ngược (mặc định true)
  useDonchianExit?: boolean; // thoát khi thủng kênh Donchian(dcExit) (mặc định true; false = tắt hẳn)
  cooldownBars?: number; // số nến CHỜ sau khi thoát mới được vào lại (mặc định 0 = không chờ) [M2]
  // ----- Phase 1: Entry Scorer + Volume filter + Break-even + Partial TP (opt-in) -----
  useEntryScore?: boolean; // bật chấm điểm entry 0–100 (mặc định false)
  entryScoreMin?: number; // ngưỡng điểm vào lệnh 0–100 (mặc định 0)
  volLen?: number; // chu kỳ SMA volume (mặc định 20)
  volMult?: number; // lọc cứng: volume > volMult × SMA(vol). 0 = tắt (mặc định 0)
  breakEvenR?: number; // dời stop về hoà vốn khi lãi ≥ R này (0 = tắt, mặc định 0)
  partialTpR?: number; // chốt 1 phần khi lãi ≥ R này (0 = tắt, mặc định 0)
  partialTpFrac?: number; // tỉ lệ chốt tại partialTpR (0..1, mặc định 0.5)
  // ----- Logic filter: XÁC NHẬN BREAKOUT bằng nến follow-through (chống fake breakout) -----
  confirmBars?: number; // số nến chờ xác nhận sau breakout (0 = vào ngay như cũ; 1 = vào ở nến kế nếu đi tiếp)
  confirmAtr?: number; // yêu cầu nến xác nhận đi tiếp ≥ confirmAtr·ATR theo chiều lệnh (mặc định 0)
  confirmSide?: "both" | "short" | "long"; // chỉ áp xác nhận cho 1 chiều (fake breakout tập trung ở SHORT). Mặc định both
}

export interface TrendSimCfg extends Required<Omit<TrendParams, never>> {}

export const TREND_DEFAULTS: TrendSimCfg = {
  dcEntry: 100,
  dcExit: 50,
  emaFast: 20,
  emaSlow: 50,
  emaTrend: 200,
  adxPeriod: 14,
  adxMin: 25,
  atrPeriod: 14,
  k1Atr: 2.5,
  k2Atr: 3.0,
  timeStopBars: 240,
  atrPctMin: 0.5,
  atrPctMax: 8,
  allowLong: true,
  allowShort: false,
  useRegimeExit: true,
  useDonchianExit: true,
  cooldownBars: 0,
  useEntryScore: false,
  entryScoreMin: 0,
  volLen: 20,
  volMult: 0,
  breakEvenR: 0,
  partialTpR: 0,
  partialTpFrac: 0.5,
  confirmBars: 0,
  confirmAtr: 0,
  confirmSide: "both",
};

export function resolveTrendCfg(p: TrendParams = {}): TrendSimCfg {
  return { ...TREND_DEFAULTS, ...p };
}

export type RegimeSide = "LONG" | "SHORT" | "OFF";
/** Cổng regime: trả hướng ĐƯỢC PHÉP giao dịch tại thời điểm ts. undefined = không lọc regime. */
export type RegimeAt = (ts: number) => RegimeSide;

export interface TrendEntry {
  side: "LONG" | "SHORT";
  entry: number; // = close nến mới nhất
  stop: number; // hard stop = entry ∓ k1·ATR
  atr: number;
  adx: number;
  reason: string;
}

/**
 * Phát hiện tín hiệu vào lệnh tại NẾN MỚI NHẤT (đã đóng) — dùng cho bot tự đánh (live/paper).
 * Trả null nếu nến cuối không phải điểm vào. `regimeSide` = cổng regime (LONG/SHORT/OFF);
 * truyền "OFF" hoặc undefined nếu KHÔNG lọc regime (cho phép cả 2 chiều theo cfg).
 */
export function detectTrendEntry(
  klines: Kline[],
  cfg: TrendSimCfg,
  regimeSide?: RegimeSide
): TrendEntry | null {
  const n = klines.length;
  const need = Math.max(cfg.emaTrend + 2, cfg.dcEntry + 2, cfg.adxPeriod * 2 + 2);
  if (n < need) return null;

  const close = klines.map((k) => k.close);
  const emaF = emaSeries(close, cfg.emaFast);
  const emaS = emaSeries(close, cfg.emaSlow);
  const emaT = emaSeries(close, cfg.emaTrend);
  const atr = atrSeries(klines, cfg.atrPeriod);
  const adx = adxSeries(klines, cfg.adxPeriod);
  const donHi = donchianHighSeries(klines, cfg.dcEntry);
  const donLo = donchianLowSeries(klines, cfg.dcEntry);

  const i = n - 1; // nến mới nhất đã đóng
  if (
    !Number.isFinite(emaF[i]) || !Number.isFinite(emaS[i]) || !Number.isFinite(emaT[i]) ||
    !Number.isFinite(atr[i]) || !Number.isFinite(adx[i]) || !Number.isFinite(donHi[i]) || !Number.isFinite(donLo[i])
  ) {
    return null;
  }
  const c = klines[i];
  const a = atr[i];
  const atrPct = (a / c.close) * 100;
  if (atrPct < cfg.atrPctMin || atrPct > cfg.atrPctMax) return null;

  const regimeOk = (side: "LONG" | "SHORT") =>
    !regimeSide || regimeSide === "OFF" ? false : regimeSide === side;
  // Nếu KHÔNG dùng regime (regimeSide undefined) -> bỏ cổng, chỉ theo cfg.allow*
  const gate = (side: "LONG" | "SHORT") => (regimeSide === undefined ? true : regimeOk(side));

  const longOk =
    cfg.allowLong && gate("LONG") &&
    c.close > emaT[i] && emaF[i] > emaS[i] && adx[i] > cfg.adxMin && c.close > donHi[i];
  const shortOk =
    cfg.allowShort && gate("SHORT") &&
    c.close < emaT[i] && emaF[i] < emaS[i] && adx[i] > cfg.adxMin && c.close < donLo[i];

  if (!longOk && !shortOk) return null;
  const side: "LONG" | "SHORT" = longOk ? "LONG" : "SHORT";
  const entry = c.close;
  const stop = side === "LONG" ? entry - cfg.k1Atr * a : entry + cfg.k1Atr * a;
  return {
    side,
    entry,
    stop,
    atr: a,
    adx: adx[i],
    reason: `${side} Donchian breakout DC${cfg.dcEntry} · ADX ${adx[i].toFixed(0)} · ATR% ${atrPct.toFixed(1)}`,
  };
}

/**
 * Mô phỏng toàn bộ trade trend-following cho 1 symbol trên chuỗi nến ĐÃ ĐÓNG.
 * Không chồng lệnh trên cùng symbol. Fill tại close nến tín hiệu (nhất quán với các engine khác).
 *
 * `barMs` = độ dài 1 nến (ms) của khung alt. Dùng để hỏi regime tại THỜI ĐIỂM NẾN ĐÓNG
 * (`openTime + barMs`) — khớp với point-in-time của regime (đánh dấu theo closeTime). Truyền 0
 * sẽ hỏi tại openTime (lùi 1 nến regime — an toàn nhưng bảo thủ). [C1]
 */
export function simulateSymbolTrend(
  symbol: string,
  klines: Kline[],
  cfg: TrendSimCfg,
  regimeAt?: RegimeAt,
  barMs = 0
): BacktestTrade[] {
  const trades: BacktestTrade[] = [];
  const n = klines.length;
  const close = klines.map((k) => k.close);

  const emaF = emaSeries(close, cfg.emaFast);
  const emaS = emaSeries(close, cfg.emaSlow);
  const emaT = emaSeries(close, cfg.emaTrend);
  const atr = atrSeries(klines, cfg.atrPeriod);
  const adx = adxSeries(klines, cfg.adxPeriod);
  const donHi = donchianHighSeries(klines, cfg.dcEntry);
  const donLo = donchianLowSeries(klines, cfg.dcEntry);
  const donHiX = donchianHighSeries(klines, cfg.dcExit);
  const donLoX = donchianLowSeries(klines, cfg.dcExit);
  const volSMA = smaSeries(klines.map((k) => k.volume), cfg.volLen); // Phase 1: xác nhận volume

  const finite = (i: number) =>
    Number.isFinite(emaF[i]) &&
    Number.isFinite(emaS[i]) &&
    Number.isFinite(emaT[i]) &&
    Number.isFinite(atr[i]) &&
    Number.isFinite(adx[i]) &&
    Number.isFinite(donHi[i]) &&
    Number.isFinite(donLo[i]);

  let i = 1;
  // Dừng ở n-1: KHÔNG mở lệnh ở nến cuối chuỗi (không có nến sau để quản lý → trade rác
  // barsHeld=0, pnl=−phí) làm bẩn thống kê, nhất là khi chạy grid nhiều cửa sổ ngắn. [M9-a]
  while (i < n - 1) {
    if (!finite(i)) {
      i++;
      continue;
    }
    const c = klines[i];
    const a = atr[i];
    const atrPct = (a / c.close) * 100;
    const volOk = atrPct >= cfg.atrPctMin && atrPct <= cfg.atrPctMax;
    // Hỏi regime tại THỜI ĐIỂM NẾN ĐÓNG (point-in-time, không look-ahead). [C1]
    const allow = regimeAt ? regimeAt(c.openTime + barMs) : "OFF";

    // ---- Xác định hướng vào lệnh ----
    const longOk =
      cfg.allowLong &&
      volOk &&
      (!regimeAt || allow === "LONG") &&
      c.close > emaT[i] &&
      emaF[i] > emaS[i] &&
      adx[i] > cfg.adxMin &&
      c.close > donHi[i];
    const shortOk =
      cfg.allowShort &&
      volOk &&
      (!regimeAt || allow === "SHORT") &&
      c.close < emaT[i] &&
      emaF[i] < emaS[i] &&
      adx[i] > cfg.adxMin &&
      c.close < donLo[i];

    if (!longOk && !shortOk) {
      i++;
      continue;
    }
    const long = longOk; // long ưu tiên nếu cả hai (không xảy ra: điều kiện loại trừ nhau)

    // ----- Phase 1: lọc volume cứng + chấm điểm entry (opt-in) -----
    const volSMAi = volSMA[i];
    const volRatio = Number.isFinite(volSMAi) && volSMAi > 0 ? c.volume / volSMAi : 1;
    if (cfg.volMult > 0 && volRatio < cfg.volMult) { i++; continue; }
    if (cfg.useEntryScore) {
      const brkAtr = a > 0 ? (long ? (c.close - donHi[i]) : (donLo[i] - c.close)) / a : 0;
      const score = entryScore(long, adx[i], volRatio, brkAtr, atrPct, cfg.atrPctMin, cfg.atrPctMax);
      if (score < cfg.entryScoreMin) { i++; continue; }
    }

    // ----- Logic: XÁC NHẬN BREAKOUT (opt-in) — chờ nến follow-through, chống fake breakout. [Forensics R1]
    // Fake breakout (đảo ngay, chưa từng lời) = 46% số lệnh thua, tập trung ở SHORT. Nến kế đi tiếp
    // (nextConfirm) phân biệt thắng/fake rõ nhất → vào ở nến xác nhận thay vì nến breakout.
    const applyConfirm =
      cfg.confirmBars > 0 &&
      (cfg.confirmSide === "both" || (cfg.confirmSide === "short" && !long) || (cfg.confirmSide === "long" && long));
    let entryIdx = i;
    if (applyConfirm) {
      const cj = i + cfg.confirmBars;
      if (cj >= n - 1 || !Number.isFinite(atr[cj])) { i++; continue; }
      const followK = klines[cj];
      const cont = long ? followK.close - c.close : c.close - followK.close;
      if (cont < cfg.confirmAtr * a) { i++; continue; } // nến kế KHÔNG đi tiếp đủ mạnh → coi là fake, bỏ
      entryIdx = cj;
    }
    const ec = klines[entryIdx]; // nến VÀO LỆNH (có thể lệch so với nến tín hiệu nếu bật xác nhận)
    const entry = ec.close;
    const entryAtr = Number.isFinite(atr[entryIdx]) ? atr[entryIdx] : a;
    let hardStop = long ? entry - cfg.k1Atr * entryAtr : entry + cfg.k1Atr * entryAtr;
    let partialHit = false; // đã chạm mốc chốt 1 phần chưa (partial TP)
    const riskDist = Math.abs(entry - hardStop);
    if (riskDist <= 0) {
      i++;
      continue;
    }
    const riskPctPrice = (riskDist / entry) * 100;

    const legPnl = (px: number) =>
      long ? ((px - entry) / entry) * 100 : ((entry - px) / entry) * 100;

    // ---- Đi tới các nến sau để tìm điểm thoát ----
    let hh = ec.high; // highest high kể từ entry (LONG)
    let ll = ec.low; // lowest low kể từ entry (SHORT)
    let exitIdx = -1;
    let exitPrice = 0;
    let reason: BacktestTrade["reason"] = "EOD";
    let worstAdvPct = 0; // MAE (≤ 0)
    let worstAdvTime = ec.openTime;
    let bestFavPct = 0; // MFE (≥ 0)
    let bestFavTime = ec.openTime;

    for (let j = entryIdx + 1; j < n; j++) {
      const k = klines[j];
      // Chandelier dùng ATR của nến ĐÃ ĐÓNG TRƯỚC (j-1): mức stop "treo" trong nến j chỉ được
      // biết bằng thông tin tới hết nến j-1 (tránh look-ahead intrabar do ATR[j] chứa H/L/C của j). [H1]
      const aj = Number.isFinite(atr[j - 1]) ? atr[j - 1] : entryAtr;

      // ----- Phase 1: break-even + phát hiện partial TP (point-in-time: dùng MFE tới nến j-1) -----
      if (cfg.breakEvenR > 0 && bestFavPct >= cfg.breakEvenR * riskPctPrice) {
        hardStop = long ? Math.max(hardStop, entry) : Math.min(hardStop, entry);
      }
      if (cfg.partialTpR > 0 && !partialHit && bestFavPct >= cfg.partialTpR * riskPctPrice) {
        partialHit = true;
      }

      // MAE/MFE
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

      // Cập nhật extreme cho chandelier (dùng extreme TRƯỚC nến này để tính stop áp cho nến này)
      const chandelier = long ? hh - cfg.k2Atr * aj : ll + cfg.k2Atr * aj;
      // Stop hiệu lực = XA hơn giữa hard stop và chandelier (chandelier chỉ siết khi đã có lời).
      const effStop = long ? Math.max(hardStop, chandelier) : Math.min(hardStop, chandelier);
      const stopReason: BacktestTrade["reason"] = effStop === hardStop ? "SL" : "TRAIL";

      // (1) Intrabar (bi quan): xét phía bất lợi trước. Gap qua stop -> fill tại open.
      const hitStop = long ? k.low <= effStop : k.high >= effStop;
      if (hitStop) {
        const gapped = long ? k.open < effStop : k.open > effStop;
        exitPrice = gapped ? k.open : effStop;
        reason = stopReason;
        exitIdx = j;
        break;
      }
      // (2) Donchian exit (thuần giá): thủng kênh đối diện dcExit. Nhãn riêng DONCHIAN để
      // phân tách attribution với chandelier (TRAIL). [H4] Bỏ qua nếu tắt Donchian-exit.
      if (cfg.useDonchianExit) {
      if (long && Number.isFinite(donLoX[j]) && k.low <= donLoX[j]) {
        exitPrice = Math.min(k.open, donLoX[j]);
        reason = "DONCHIAN";
        exitIdx = j;
        break;
      }
      if (!long && Number.isFinite(donHiX[j]) && k.high >= donHiX[j]) {
        exitPrice = Math.max(k.open, donHiX[j]);
        reason = "DONCHIAN";
        exitIdx = j;
        break;
      }
      }
      // (3) Regime flip -> đóng tại close. Hỏi regime tại thời điểm nến j ĐÓNG. [C1]
      if (cfg.useRegimeExit && regimeAt) {
        const rg = regimeAt(k.openTime + barMs);
        if ((long && rg === "SHORT") || (!long && rg === "LONG")) {
          exitPrice = k.close;
          reason = "FLIP";
          exitIdx = j;
          break;
        }
      }
      // (4) Time stop: giữ đủ lâu mà lãi < 0.5R -> đóng tại close. Nhãn riêng TIME (tách khỏi EOD
      // "hết dữ liệu") để attribution đúng. [H4]
      if (j - i >= cfg.timeStopBars) {
        const curR = legPnl(k.close) / riskPctPrice;
        if (curR < 0.5) {
          exitPrice = k.close;
          reason = "TIME";
          exitIdx = j;
          break;
        }
      }

      // Cập nhật extreme SAU khi đã xét stop cho nến này (chandelier siết từ nến kế tiếp).
      if (k.high > hh) hh = k.high;
      if (k.low < ll) ll = k.low;
    }

    if (exitIdx === -1) {
      exitIdx = n - 1;
      exitPrice = klines[exitIdx].close;
      reason = "EOD";
    }

    // Partial TP: chốt partialTpFrac tại +partialTpR, phần còn lại chạy tới exit (blend pnl). [Phase 1]
    const finalPnl = legPnl(exitPrice);
    const pnlPct =
      cfg.partialTpR > 0 && partialHit
        ? cfg.partialTpFrac * (cfg.partialTpR * riskPctPrice) + (1 - cfg.partialTpFrac) * finalPnl
        : finalPnl;
    trades.push({
      symbol,
      side: long ? "LONG" : "SHORT",
      maePct: Math.min(0, worstAdvPct),
      maeTime: worstAdvTime,
      mfePct: Math.max(0, bestFavPct),
      mfeTime: bestFavTime,
      entryTime: ec.openTime,
      entryPrice: entry,
      exitTime: klines[exitIdx].openTime,
      exitPrice,
      pnlPct,
      pnlUsdt: 0,
      reason,
      barsHeld: exitIdx - entryIdx,
      probability: Math.min(100, Math.round(adx[i])), // dùng ADX làm điểm "độ mạnh trend"
      riskPctPrice,
      alignment: "MOMENTUM", // trend breakout = nhóm momentum (cho byAlignment)
    });

    i = exitIdx + 1 + Math.max(0, cfg.cooldownBars); // không chồng lệnh + chờ cooldown [M2]
  }

  return trades;
}
