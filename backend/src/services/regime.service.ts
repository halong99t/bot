import fs from "fs";
import path from "path";
import { binance, Kline } from "../lib/binance";
import { env } from "../config/env";
import { logger } from "../lib/logger";
import { emaSeries } from "./indicators";
import type { RegimeAt, RegimeSide } from "./trend.service";

/**
 * REGIME FILTER — cổng bật/tắt sách LONG/SHORT theo BTC.
 *
 * Dữ liệu 1m local KHÔNG có BTC/ETH (chỉ altcoin), nên phải KÉO BTC từ Binance
 * (public, giá production) rồi cache ra đĩa để backtest chạy offline các lần sau.
 *
 * Regime = so close BTC với EMA(regimeEmaPeriod) trên khung regimeInterval:
 *   close > EMA -> LONG_ON ; close < EMA -> SHORT_ON.
 */

const BTC_CACHE_DIR = path.join(env.DATA_1M_DIR, "_cache", "_btc");
const DAY_MS = 24 * 60 * 60 * 1000;

function cachePath(symbol: string, interval: string): string {
  return path.join(BTC_CACHE_DIR, `${symbol}__${interval}.json`);
}

function readCache(symbol: string, interval: string): Kline[] | null {
  const fp = cachePath(symbol, interval);
  if (!fs.existsSync(fp)) return null;
  try {
    const arr = JSON.parse(fs.readFileSync(fp, "utf8")) as number[][];
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
    return null;
  }
}

function writeCache(symbol: string, interval: string, klines: Kline[]): void {
  try {
    if (!fs.existsSync(BTC_CACHE_DIR)) fs.mkdirSync(BTC_CACHE_DIR, { recursive: true });
    const compact = klines.map((k) => [k.openTime, k.open, k.high, k.low, k.close, k.volume]);
    fs.writeFileSync(cachePath(symbol, interval), JSON.stringify(compact));
  } catch (err) {
    logger.warn("strategy", `Ghi cache BTC ${symbol}/${interval} lỗi: ${String(err)}`);
  }
}

const intervalMs: Record<string, number> = {
  "1h": 60 * 60_000,
  "4h": 4 * 60 * 60_000,
  "1d": DAY_MS,
};

/**
 * Lấy klines BTC (hoặc symbol regime) phủ [fromMs, toMs] — đọc cache nếu đã bao phủ,
 * ngược lại fetch từ Binance rồi lưu cache. Trả rỗng nếu offline & không có cache.
 */
export async function getRegimeKlines(
  symbol: string,
  interval: string,
  fromMs: number,
  toMs: number
): Promise<Kline[]> {
  const cached = readCache(symbol, interval);
  const step = intervalMs[interval] ?? DAY_MS;
  const covers =
    cached &&
    cached.length > 1 &&
    cached[0].openTime <= fromMs + step &&
    cached[cached.length - 1].openTime >= toMs - step;
  if (covers) return cached!;

  try {
    const fetched = await binance.getKlinesRange(symbol, interval, fromMs, toMs, 60000);
    if (fetched.length) {
      writeCache(symbol, interval, fetched);
      logger.info("strategy", `Kéo ${fetched.length} nến ${symbol}/${interval} từ Binance (cache đĩa)`);
      return fetched;
    }
  } catch (err) {
    logger.warn("strategy", `Kéo ${symbol}/${interval} lỗi: ${String(err)}`);
  }
  return cached ?? [];
}

export interface RegimeConfig {
  symbol?: string; // mặc định BTCUSDT
  interval?: string; // mặc định 1d
  emaPeriod?: number; // mặc định 200
  allowLong?: boolean;
  allowShort?: boolean;
  // ----- Regime ĐA TẦNG (tùy chọn) -----
  useSlope?: boolean; // yêu cầu EMA đang dốc đúng chiều (đang tăng cho LONG)
  slopeLookback?: number; // số nến so EMA để đo độ dốc (mặc định 20)
  useBreadth?: boolean; // yêu cầu breadth thị trường (% coin trên EMA) đủ mạnh
  breadthMin?: number; // ngưỡng breadth cho LONG (0..1, mặc định 0.5); SHORT cần ≤ 1−ngưỡng
}

/**
 * Breadth theo NGÀY = tỉ lệ coin có close > EMA(emaPeriod) của chính nó.
 * Đo "độ rộng" thị trường: uptrend khỏe khi phần lớn coin ở trên EMA.
 * Trả Map<dayIndex, fraction 0..1>.
 */
export function computeBreadthByDay(
  dailyBySymbol: Map<string, Kline[]>,
  emaPeriod = 200
): Map<number, number> {
  const above = new Map<number, number>();
  const total = new Map<number, number>();
  for (const kl of dailyBySymbol.values()) {
    if (kl.length < emaPeriod + 1) continue;
    const closes = kl.map((k) => k.close);
    const ema = emaSeries(closes, emaPeriod);
    for (let i = 0; i < kl.length; i++) {
      if (!Number.isFinite(ema[i])) continue;
      const d = Math.floor(kl[i].openTime / DAY_MS);
      total.set(d, (total.get(d) ?? 0) + 1);
      if (closes[i] > ema[i]) above.set(d, (above.get(d) ?? 0) + 1);
    }
  }
  const out = new Map<number, number>();
  for (const [d, t] of total) out.set(d, t > 0 ? (above.get(d) ?? 0) / t : 0);
  return out;
}

export interface RegimeSeries {
  times: number[]; // openTime tăng dần
  side: RegimeSide[]; // regime tại mỗi mốc
  symbol: string;
  interval: string;
  emaPeriod: number;
}

/**
 * Dựng chuỗi regime từ klines BTC.
 * Cơ bản: side[i] = LONG nếu close>EMA, SHORT nếu <EMA (EMA chưa warmup -> OFF).
 * Đa tầng (tùy chọn):
 *  - useSlope: LONG cần EMA đang tăng (ema[i] > ema[i−slopeLookback]); SHORT cần EMA giảm.
 *  - useBreadth: LONG cần breadth ≥ breadthMin; SHORT cần breadth ≤ 1−breadthMin.
 *  Không thỏa điều kiện tầng phụ -> OFF (đứng ngoài).
 */
export function buildRegimeSeries(
  klines: Kline[],
  cfg: RegimeConfig,
  breadthByDay?: Map<number, number>
): RegimeSeries {
  const emaPeriod = cfg.emaPeriod ?? 200;
  const slopeLookback = cfg.slopeLookback ?? 20;
  const breadthMin = cfg.breadthMin ?? 0.5;
  // Bước khung để suy ra closeTime = openTime + step. Regime của nến i tính từ close[i] nên chỉ
  // hiệu lực TỪ thời điểm nến i ĐÓNG → đánh dấu mốc theo closeTime để makeRegimeAt là point-in-time
  // thật (không look-ahead khi khung regime thô hơn khung entry). [C1]
  const step = intervalMs[cfg.interval ?? "1d"] ?? DAY_MS;
  const close = klines.map((k) => k.close);
  const ema = emaSeries(close, emaPeriod);
  const times: number[] = [];
  const side: RegimeSide[] = [];
  for (let i = 0; i < klines.length; i++) {
    times.push(klines[i].openTime + step);
    if (!Number.isFinite(ema[i])) {
      side.push("OFF");
      continue;
    }
    let s: RegimeSide = close[i] > ema[i] ? "LONG" : "SHORT";
    // Tầng độ dốc EMA (chưa đủ nến để đo -> coi như thỏa, không chặn đầu chuỗi).
    if (cfg.useSlope && i >= slopeLookback && Number.isFinite(ema[i - slopeLookback])) {
      const rising = ema[i] > ema[i - slopeLookback];
      if ((s === "LONG" && !rising) || (s === "SHORT" && rising)) s = "OFF";
    }
    // Tầng breadth thị trường. Tra theo NGÀY của chính nến (openTime) — breadth[d] tính từ close
    // ngày d, biết được lúc ngày d đóng; KHÔNG dùng times[i] (đã dời sang closeTime) để tránh lệch ngày.
    if (s !== "OFF" && cfg.useBreadth && breadthByDay) {
      const b = breadthByDay.get(Math.floor(klines[i].openTime / DAY_MS));
      if (b !== undefined) {
        if (s === "LONG" && b < breadthMin) s = "OFF";
        else if (s === "SHORT" && b > 1 - breadthMin) s = "OFF";
      }
    }
    side.push(s);
  }
  return {
    times,
    side,
    symbol: cfg.symbol ?? "BTCUSDT",
    interval: cfg.interval ?? "1d",
    emaPeriod,
  };
}

/**
 * Tạo hàm regimeAt(ts): trả regime của mốc regime GẦN NHẤT ≤ ts (point-in-time, không look-ahead).
 * Trước mốc đầu tiên -> OFF.
 */
export function makeRegimeAt(series: RegimeSeries): RegimeAt {
  const { times, side } = series;
  return (ts: number): RegimeSide => {
    // binary search: mốc lớn nhất có times[idx] <= ts
    let lo = 0;
    let hi = times.length - 1;
    if (!times.length || ts < times[0]) return "OFF";
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (times[mid] <= ts) lo = mid;
      else hi = mid - 1;
    }
    return side[lo];
  };
}

/**
 * Regime ĐA KHUNG: kết hợp 2 chuỗi (vd BTC 1h + 4h). Chỉ vào lệnh khi 2 khung ĐỒNG THUẬN:
 *  cả hai LONG -> LONG; cả hai SHORT -> SHORT; lệch nhau -> OFF (đứng ngoài).
 */
export function makeComboRegimeAt(a: RegimeSeries, b: RegimeSeries): RegimeAt {
  const atA = makeRegimeAt(a);
  const atB = makeRegimeAt(b);
  return (ts: number): RegimeSide => {
    const x = atA(ts);
    const y = atB(ts);
    if (x === "LONG" && y === "LONG") return "LONG";
    if (x === "SHORT" && y === "SHORT") return "SHORT";
    return "OFF";
  };
}

/**
 * Tiện ích: kéo BTC + dựng regimeAt phủ [fromMs, toMs] (đệm warmup EMA).
 * Trả null nếu không lấy được dữ liệu (offline & chưa cache) -> caller có thể chạy KHÔNG regime.
 */
export async function prepareRegimeAt(
  fromMs: number,
  toMs: number,
  cfg: RegimeConfig = {}
): Promise<{ regimeAt: RegimeAt; series: RegimeSeries } | null> {
  const symbol = cfg.symbol ?? "BTCUSDT";
  const interval = cfg.interval ?? "1d";
  const emaPeriod = cfg.emaPeriod ?? 200;
  const step = intervalMs[interval] ?? DAY_MS;
  // Đệm warmup: cần emaPeriod nến TRƯỚC fromMs để EMA đã "ấm" ngay từ đầu kỳ backtest.
  const warmFrom = fromMs - (emaPeriod + 5) * step;
  const klines = await getRegimeKlines(symbol, interval, warmFrom, toMs);
  if (klines.length < emaPeriod + 2) {
    logger.warn(
      "strategy",
      `Regime ${symbol}/${interval}: không đủ nến (${klines.length}) -> chạy KHÔNG regime`
    );
    return null;
  }
  const series = buildRegimeSeries(klines, { symbol, interval, emaPeriod });
  return { regimeAt: makeRegimeAt(series), series };
}
