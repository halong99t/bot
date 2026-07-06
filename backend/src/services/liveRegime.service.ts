import { getLocalSeriesForSymbol } from "./backtest.service";
import { getRegimeKlines } from "./regime.service";
import { emaSeries } from "./indicators";
import { logger } from "../lib/logger";
import type { RegimeSide } from "./trend.service";

/**
 * REGIME LIVE cho bot tự đánh (paper). Tự cập nhật theo thời gian:
 *  - Nguồn: BTC trong /1m local (đã tải). Fallback kéo Binance nếu thiếu.
 *  - Regime = close BTC (khung 1d) so EMA(emaPeriod). Cache, refresh mỗi `ttlMs`.
 */

const REGIME_SYMBOL = "BTCUSDT";
const REGIME_EMA = 200;
const TTL_MS = 30 * 60 * 1000; // refresh tối đa mỗi 30 phút

// Chỉ còn một mode BTC1H_ALT1H → regime luôn dùng khung BTC 1h.
function regimeIntervalOf(_mode?: string): string {
  return "1h";
}

let cached: { side: RegimeSide; at: number; close: number; ema: number; interval: string } | null = null;

/** Tính lại regime từ dữ liệu mới nhất theo mode (BTC 1h hoặc 4h). */
export async function refreshRegime(mode = "BTC1H_ALT1H"): Promise<RegimeSide> {
  const interval = regimeIntervalOf(mode);
  try {
    let kl = await getLocalSeriesForSymbol(REGIME_SYMBOL, interval);
    if (kl.length < REGIME_EMA + 2) {
      const now = Date.now();
      const step = interval === "4h" ? 4 * 3_600_000 : 3_600_000;
      kl = await getRegimeKlines(REGIME_SYMBOL, interval, now - (REGIME_EMA + 60) * step, now);
    }
    if (kl.length < REGIME_EMA + 2) {
      cached = { side: "OFF", at: Date.now(), close: 0, ema: 0, interval };
      return "OFF";
    }
    const close = kl.map((k) => k.close);
    const ema = emaSeries(close, REGIME_EMA);
    const i = kl.length - 1;
    const side: RegimeSide = !Number.isFinite(ema[i]) ? "OFF" : close[i] > ema[i] ? "LONG" : "SHORT";
    cached = { side, at: Date.now(), close: close[i], ema: ema[i], interval };
    return side;
  } catch (err) {
    logger.warn("strategy", `Live regime lỗi: ${String(err)}`);
    return cached?.side ?? "OFF";
  }
}

/** Regime hiện tại (dùng cache nếu còn mới, else refresh). */
export async function getCurrentRegime(mode = "BTC1H_ALT1H"): Promise<RegimeSide> {
  const interval = regimeIntervalOf(mode);
  if (cached && cached.interval === interval && Date.now() - cached.at < TTL_MS) return cached.side;
  return refreshRegime(mode);
}

/** Ảnh chụp regime cho UI/log. */
export function getRegimeSnapshot() {
  return cached;
}
