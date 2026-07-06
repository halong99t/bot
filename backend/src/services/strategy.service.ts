import { Kline } from "../lib/binance";

/**
 * CHỨC NĂNG 2: Phát hiện mô hình LONG.
 *
 * Logic chiến lược (dựa trên nến đã đóng):
 *  Bước 1: Coin giảm mạnh tối thiểu 15% (từ đỉnh gần đây xuống đáy vùng giảm).
 *  Bước 2: Sau khi giảm phải sideway: tối thiểu 20 nến, biên độ < 5%.
 *  Bước 3: Xuất hiện 3 nến tăng liên tiếp, tổng mức tăng >= 10%.
 *  Bước 4: Nến thứ 3 breakout vượt đỉnh vùng sideway.
 */

export interface PatternResult {
  matched: boolean;
  reason: string;
  probability: number; // 0-100
  entryPrice: number; // giá vào lệnh đề xuất (close nến breakout)
  sidewayHigh: number;
  sidewayLow: number;
  dropPct: number;
  risePct: number;
}

export interface StrategyParams {
  minDropPct?: number; // mặc định 15
  minSidewayCandles?: number; // mặc định 20
  maxSidewayRangePct?: number; // mặc định 5
  minRisePct?: number; // mặc định 10 (tổng 3 nến)
}

const DEFAULTS: Required<StrategyParams> = {
  minDropPct: 15,
  minSidewayCandles: 20,
  maxSidewayRangePct: 5,
  minRisePct: 10,
};

/**
 * Phân tích mảng nến (cũ -> mới). Cần >= ~50 nến để có ý nghĩa.
 * Quy ước: 3 nến cuối cùng là cụm breakout (Bước 3+4),
 * vùng sideway nằm ngay trước đó.
 */
export function detectLongPattern(
  klines: Kline[],
  params: StrategyParams = {}
): PatternResult {
  const p = { ...DEFAULTS, ...params };
  const fail = (reason: string): PatternResult => ({
    matched: false,
    reason,
    probability: 0,
    entryPrice: 0,
    sidewayHigh: 0,
    sidewayLow: 0,
    dropPct: 0,
    risePct: 0,
  });

  const n = klines.length;
  if (n < p.minSidewayCandles + 5) {
    return fail(`Không đủ dữ liệu nến (${n})`);
  }

  // 3 nến cuối = cụm tăng/breakout
  const last3 = klines.slice(n - 3);

  // ---- Bước 3: 3 nến tăng liên tiếp ----
  const allBullish = last3.every((k) => k.close > k.open);
  if (!allBullish) return fail("Bước 3 thất bại: 3 nến cuối không tăng liên tiếp");

  const riseStart = last3[0].open;
  const riseEnd = last3[2].close;
  const risePct = ((riseEnd - riseStart) / riseStart) * 100;
  if (risePct < p.minRisePct) {
    return fail(`Bước 3 thất bại: tổng tăng ${risePct.toFixed(2)}% < ${p.minRisePct}%`);
  }

  // ---- Bước 2: sideway (CỬA SỔ TRƯỢT) ----
  // Tìm vùng tích lũy DÀI NHẤT (>= minSidewayCandles) kết thúc ngay trước 3 nến breakout
  // mà biên độ vẫn <= maxSidewayRangePct. Mở rộng window: biên độ chỉ tăng dần nên
  // dừng lại khi vượt ngưỡng -> đó là vùng sideway dài nhất hợp lệ.
  const maxLen = Math.min(240, n - 3 - 5); // chừa >=5 nến cho vùng trước đó
  if (maxLen < p.minSidewayCandles) return fail("Không đủ dữ liệu cho vùng sideway");

  let swHigh = 0;
  let swLow = 0;
  let swRangePct = 0;
  let swLen = 0;
  for (let L = p.minSidewayCandles; L <= maxLen; L++) {
    const win = klines.slice(n - 3 - L, n - 3);
    const hi = Math.max(...win.map((k) => k.high));
    const lo = Math.min(...win.map((k) => k.low));
    const range = ((hi - lo) / lo) * 100;
    if (range <= p.maxSidewayRangePct) {
      swHigh = hi;
      swLow = lo;
      swRangePct = range;
      swLen = L;
    } else {
      break; // biên độ vượt ngưỡng -> dừng, giữ vùng dài nhất đã hợp lệ
    }
  }
  if (swLen === 0) {
    return fail(`Bước 2 thất bại: không có vùng sideway >= ${p.minSidewayCandles} nến biên < ${p.maxSidewayRangePct}%`);
  }

  // ---- Bước 1: giảm mạnh trước vùng sideway ----
  const preWindow = klines.slice(0, n - 3 - swLen);
  if (preWindow.length < 5) return fail("Không đủ dữ liệu trước vùng sideway");
  const recentPre = preWindow.slice(-60); // 60 nến gần nhất trước sideway
  const peakBeforeDrop = Math.max(...recentPre.map((k) => k.high));
  const dropPct = ((peakBeforeDrop - swLow) / peakBeforeDrop) * 100;
  if (dropPct < p.minDropPct) {
    return fail(`Bước 1 thất bại: chỉ giảm ${dropPct.toFixed(2)}% < ${p.minDropPct}%`);
  }

  // ---- Bước 4: breakout vượt đỉnh sideway ----
  const breakoutClose = last3[2].close;
  if (breakoutClose <= swHigh) {
    return fail(
      `Bước 4 thất bại: close ${breakoutClose} chưa vượt đỉnh sideway ${swHigh}`
    );
  }

  // ---- Tính xác suất (heuristic scoring 0-100) ----
  let probability = 50;
  // drop càng sâu càng tốt (tối đa +15)
  probability += Math.min((dropPct - p.minDropPct) * 0.8, 15);
  // sideway càng chặt càng tốt (tối đa +15)
  probability += Math.min((p.maxSidewayRangePct - swRangePct) * 3, 15);
  // rise càng mạnh càng tốt (tối đa +15)
  probability += Math.min((risePct - p.minRisePct) * 1.0, 15);
  // breakout vượt đỉnh nhiều (tối đa +5)
  const breakoutMargin = ((breakoutClose - swHigh) / swHigh) * 100;
  probability += Math.min(breakoutMargin * 2, 5);
  probability = Math.max(0, Math.min(100, Math.round(probability)));

  return {
    matched: true,
    reason: `Drop ${dropPct.toFixed(1)}% → sideway ${swLen} nến (range ${swRangePct.toFixed(
      1
    )}%) → 3 nến tăng +${risePct.toFixed(1)}% breakout đỉnh`,
    probability,
    entryPrice: breakoutClose,
    sidewayHigh: swHigh,
    sidewayLow: swLow,
    dropPct,
    risePct,
  };
}
