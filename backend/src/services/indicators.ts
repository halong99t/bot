import { RSI, EMA, ATR, ADX } from "technicalindicators";
import { Kline } from "../lib/binance";

/**
 * Bộ tính chỉ báo kỹ thuật từ mảng nến.
 * Trả về giá trị mới nhất (last value) cho mỗi chỉ báo.
 */

export interface Indicators {
  rsi: number | null;
  ema20: number | null;
  ema50: number | null;
  ema200: number | null;
  atr: number | null;
}

function lastOf(arr: number[]): number | null {
  return arr.length ? arr[arr.length - 1] : null;
}

export function computeIndicators(klines: Kline[]): Indicators {
  const close = klines.map((k) => k.close);
  const high = klines.map((k) => k.high);
  const low = klines.map((k) => k.low);

  const rsi = close.length >= 15 ? lastOf(RSI.calculate({ period: 14, values: close })) : null;
  const ema20 = close.length >= 20 ? lastOf(EMA.calculate({ period: 20, values: close })) : null;
  const ema50 = close.length >= 50 ? lastOf(EMA.calculate({ period: 50, values: close })) : null;
  const ema200 =
    close.length >= 200 ? lastOf(EMA.calculate({ period: 200, values: close })) : null;
  const atr =
    close.length >= 15
      ? lastOf(ATR.calculate({ period: 14, high, low, close }))
      : null;

  return { rsi, ema20, ema50, ema200, atr };
}

// ===================== SERIES (căn theo index nến) =====================
// Các helper trả mảng CÙNG ĐỘ DÀI với klines, pad NaN ở đầu cho tới khi warmup xong.
// Dùng cho backtest chiến lược trend-following (Donchian/ADX/EMA/ATR per-bar).

/** Pad NaN đầu mảng cho đủ độ dài `len` (kết quả indicator ngắn hơn input). */
function padTo(len: number, out: number[]): number[] {
  const pad = len - out.length;
  return pad > 0 ? [...new Array(pad).fill(NaN), ...out] : out;
}

/** EMA theo index nến. */
export function emaSeries(values: number[], period: number): number[] {
  if (values.length < period) return new Array(values.length).fill(NaN);
  return padTo(values.length, EMA.calculate({ period, values }));
}

/** ATR theo index nến. */
export function atrSeries(klines: Kline[], period = 14): number[] {
  if (klines.length < period + 1) return new Array(klines.length).fill(NaN);
  return padTo(
    klines.length,
    ATR.calculate({
      period,
      high: klines.map((k) => k.high),
      low: klines.map((k) => k.low),
      close: klines.map((k) => k.close),
    })
  );
}

/** ADX (Wilder) theo index nến. */
export function adxSeries(klines: Kline[], period = 14): number[] {
  if (klines.length < period * 2 + 1) return new Array(klines.length).fill(NaN);
  const raw = ADX.calculate({
    period,
    high: klines.map((k) => k.high),
    low: klines.map((k) => k.low),
    close: klines.map((k) => k.close),
  });
  return padTo(klines.length, raw.map((r: any) => r.adx));
}

/**
 * Donchian channel theo index: giá trị tại i = max(high)/min(low) của `period` nến
 * TRƯỚC i (không tính nến hiện tại) -> breakout so sánh close[i] với kênh đã đóng.
 * Pad NaN cho tới khi có đủ `period` nến lịch sử.
 */
export function donchianHighSeries(klines: Kline[], period: number): number[] {
  const out = new Array(klines.length).fill(NaN);
  for (let i = period; i < klines.length; i++) {
    let hi = -Infinity;
    for (let k = i - period; k < i; k++) if (klines[k].high > hi) hi = klines[k].high;
    out[i] = hi;
  }
  return out;
}

export function donchianLowSeries(klines: Kline[], period: number): number[] {
  const out = new Array(klines.length).fill(NaN);
  for (let i = period; i < klines.length; i++) {
    let lo = Infinity;
    for (let k = i - period; k < i; k++) if (klines[k].low < lo) lo = klines[k].low;
    out[i] = lo;
  }
  return out;
}

// ===================== MEAN REVERSION helpers =====================

/** Rolling mean + std (population) cửa sổ `period`. Pad NaN tới khi đủ cửa sổ. */
export function rollingMeanStd(values: number[], period: number): { mean: number[]; std: number[] } {
  const n = values.length;
  const mean = new Array(n).fill(NaN);
  const std = new Array(n).fill(NaN);
  let sum = 0;
  let sumSq = 0;
  for (let i = 0; i < n; i++) {
    sum += values[i];
    sumSq += values[i] * values[i];
    if (i >= period) {
      sum -= values[i - period];
      sumSq -= values[i - period] * values[i - period];
    }
    if (i >= period - 1) {
      const m = sum / period;
      const v = Math.max(0, sumSq / period - m * m);
      mean[i] = m;
      std[i] = Math.sqrt(v);
    }
  }
  return { mean, std };
}

/** z-score = (close − rollingMean) / rollingStd. NaN khi chưa warmup / std=0. */
export function zscoreSeries(values: number[], period: number): { z: number[]; mean: number[]; std: number[] } {
  const { mean, std } = rollingMeanStd(values, period);
  const z = values.map((v, i) => (Number.isFinite(std[i]) && std[i] > 0 ? (v - mean[i]) / std[i] : NaN));
  return { z, mean, std };
}

/** Choppiness Index(period): >~55 = đi ngang (range), thấp = trend. Pad NaN. */
export function choppinessSeries(klines: Kline[], period = 14): number[] {
  const n = klines.length;
  const out = new Array(n).fill(NaN);
  const tr = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    if (i === 0) tr[i] = klines[i].high - klines[i].low;
    else {
      const h = klines[i].high, l = klines[i].low, pc = klines[i - 1].close;
      tr[i] = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
    }
  }
  const logP = Math.log10(period);
  for (let i = period - 1; i < n; i++) {
    let sumTR = 0, hi = -Infinity, lo = Infinity;
    for (let k = i - period + 1; k <= i; k++) {
      sumTR += tr[k];
      if (klines[k].high > hi) hi = klines[k].high;
      if (klines[k].low < lo) lo = klines[k].low;
    }
    const rng = hi - lo;
    out[i] = rng > 0 ? (100 * Math.log10(sumTR / rng)) / logP : NaN;
  }
  return out;
}

/** RSI theo index nến. */
export function rsiSeries(values: number[], period = 14): number[] {
  if (values.length < period + 1) return new Array(values.length).fill(NaN);
  return padTo(values.length, RSI.calculate({ period, values }));
}

/** SMA volume theo index (cho lọc volume spike). */
export function smaSeries(values: number[], period: number): number[] {
  const n = values.length;
  const out = new Array(n).fill(NaN);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}
