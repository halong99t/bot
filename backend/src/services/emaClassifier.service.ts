import { EMA, ATR } from "technicalindicators";
import { Kline } from "../lib/binance";
import lookupJson from "./ema-classifier.lookup.json";

/**
 * EMA / Entry Position Classifier — Spec v1.0.0
 *
 * Phân loại vị thế của giá P so với EMA Fast (F) và EMA Slow (S) thành 6 trạng thái
 * LONG/SHORT, cộng thêm NEUTRAL (vùng giao cắt) và UNKNOWN (chưa warmup).
 *
 * Không viết tay 6 nhánh if: sắp 3 giá trị giảm dần -> ghép khóa (vd "P>F>S")
 * -> tra bảng lookup (ema-classifier.lookup.json).
 */

export type EmaState =
  | "LONG1"
  | "LONG2"
  | "LONG3"
  | "SHORT1"
  | "SHORT2"
  | "SHORT3"
  | "NEUTRAL"
  | "UNKNOWN";

export type EmaBias = "LONG" | "SHORT" | "NONE";
export type EmaStructure = "BULL" | "BEAR" | "NONE";
export type EmaAlignment = "MOMENTUM" | "PULLBACK" | "REVERSAL" | "NONE";
export type EmaRisk = "low" | "medium" | "high" | "none";

export interface EmaClassification {
  state: EmaState;
  bias: EmaBias;
  structure: EmaStructure;
  alignment: EmaAlignment;
  risk: EmaRisk;
}

export type EpsilonMode = "atr" | "percent" | "absolute";

export interface EmaClassifyConfig {
  epsilonMode?: EpsilonMode; // mặc định "atr"
  epsilonValue?: number; // atr: bội số ATR | percent: % của giá | absolute: đơn vị giá
  atrPeriod?: number; // dùng khi epsilonMode = "atr" (mặc định 14)
}

const LOOKUP = lookupJson as Record<string, EmaClassification>;

const NEUTRAL: EmaClassification = {
  state: "NEUTRAL",
  bias: "NONE",
  structure: "NONE",
  alignment: "NONE",
  risk: "none",
};
const UNKNOWN: EmaClassification = {
  state: "UNKNOWN",
  bias: "NONE",
  structure: "NONE",
  alignment: "NONE",
  risk: "none",
};

/** Các state phát tín hiệu vào lệnh (bỏ NEUTRAL/UNKNOWN) */
export const ENTRY_STATES: EmaState[] = ["LONG1", "LONG2", "LONG3", "SHORT3", "SHORT2", "SHORT1"];

const DEFAULT_EPS: Record<EpsilonMode, number> = {
  atr: 0.1, // 10% ATR
  percent: 0.05, // 0.05% giá
  absolute: 0, // phải truyền giá trị tuyệt đối
};

function resolveEpsilon(cfg: EmaClassifyConfig, price: number, atr: number | null): number {
  const mode = cfg.epsilonMode ?? "atr";
  const v = cfg.epsilonValue ?? DEFAULT_EPS[mode];
  switch (mode) {
    case "percent":
      return Math.abs(price) * (v / 100);
    case "absolute":
      return v;
    case "atr":
    default:
      return (atr ?? 0) * v;
  }
}

/**
 * Phân loại 1 điểm: classify(P, F, S, config).
 * - UNKNOWN nếu chưa warmup hoặc giá trị NaN.
 * - NEUTRAL nếu bất kỳ cặp nào lệch nhau dưới epsilon (vùng giao cắt).
 */
export function classify(
  P: number,
  F: number,
  S: number,
  opts: EmaClassifyConfig & { atr?: number | null; warmedUp?: boolean }
): EmaClassification {
  const warmedUp = opts.warmedUp ?? true;
  if (!warmedUp || !Number.isFinite(F) || !Number.isFinite(S) || !Number.isFinite(P)) {
    return UNKNOWN;
  }
  const eps = resolveEpsilon(opts, P, opts.atr ?? null);
  if (Math.abs(F - S) < eps || Math.abs(P - F) < eps || Math.abs(P - S) < eps) {
    return NEUTRAL;
  }
  // Sắp xếp giảm dần theo giá trị, ghép nhãn -> khóa tra bảng
  const key = (
    [
      ["P", P],
      ["F", F],
      ["S", S],
    ] as [string, number][]
  )
    .sort((a, b) => b[1] - a[1])
    .map((x) => x[0])
    .join(">");
  return LOOKUP[key] ?? NEUTRAL;
}

/** EMA căn theo index nến (pad NaN ở đầu cho đủ độ dài) */
function emaSeries(values: number[], period: number): number[] {
  if (values.length < period) return new Array(values.length).fill(NaN);
  const out = EMA.calculate({ period, values });
  const pad = values.length - out.length;
  return [...new Array(pad).fill(NaN), ...out];
}

function atrSeries(klines: Kline[], period: number): number[] {
  if (klines.length < period + 1) return new Array(klines.length).fill(NaN);
  const out = ATR.calculate({
    period,
    high: klines.map((k) => k.high),
    low: klines.map((k) => k.low),
    close: klines.map((k) => k.close),
  });
  const pad = klines.length - out.length;
  return [...new Array(pad).fill(NaN), ...out];
}

export interface ClassifiedCandle {
  index: number;
  openTime: number;
  close: number;
  fast: number;
  slow: number;
  atr: number;
  cls: EmaClassification;
  isSignal: boolean; // state khác state nến trước (emit_on = state_change)
}

export interface EmaSeriesConfig extends EmaClassifyConfig {
  fastPeriod: number;
  slowPeriod: number;
}

/**
 * Phân loại toàn bộ chuỗi nến ĐÃ ĐÓNG.
 * isSignal = state nến này khác state nến trước (bỏ qua khi nến trước là UNKNOWN).
 */
export function classifySeries(klines: Kline[], cfg: EmaSeriesConfig): ClassifiedCandle[] {
  const close = klines.map((k) => k.close);
  const fast = emaSeries(close, cfg.fastPeriod);
  const slow = emaSeries(close, cfg.slowPeriod);
  const atr = atrSeries(klines, cfg.atrPeriod ?? 14);

  const out: ClassifiedCandle[] = [];
  let prev: EmaState | null = null;
  for (let i = 0; i < klines.length; i++) {
    const warmedUp = i >= cfg.slowPeriod - 1 && Number.isFinite(slow[i]) && Number.isFinite(fast[i]);
    const cls = classify(close[i], fast[i], slow[i], {
      atr: atr[i],
      warmedUp,
      epsilonMode: cfg.epsilonMode,
      epsilonValue: cfg.epsilonValue,
      atrPeriod: cfg.atrPeriod,
    });
    const isSignal =
      prev !== null && cls.state !== prev && cls.state !== "UNKNOWN" && prev !== "UNKNOWN";
    out.push({
      index: i,
      openTime: klines[i].openTime,
      close: close[i],
      fast: fast[i],
      slow: slow[i],
      atr: atr[i],
      cls,
      isSignal,
    });
    prev = cls.state;
  }
  return out;
}
