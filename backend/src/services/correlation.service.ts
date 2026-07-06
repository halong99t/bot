import { Kline } from "../lib/binance";

/**
 * Gom cụm TƯƠNG QUAN để áp trần vị thế/cụm (correlation cap) — biến "nhiều cược cùng
 * beta BTC" thành số cược độc lập thực sự (nguồn Sharpe chính, xem docs/strategy).
 *
 * Cách làm: tính return NGÀY mỗi symbol -> Pearson correlation từng cặp trên các ngày
 * CHUNG -> nối cạnh nếu corr ≥ threshold -> connected components (union-find) = cụm.
 * (Connected-components có thể "nối chuỗi" — chấp nhận cho mục đích giới hạn phơi nhiễm.)
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** Map<dayIndex, logReturn> cho 1 symbol từ nến ngày. */
function dailyReturns(klines: Kline[]): Map<number, number> {
  const out = new Map<number, number>();
  for (let i = 1; i < klines.length; i++) {
    const prev = klines[i - 1].close;
    const cur = klines[i].close;
    if (prev > 0 && cur > 0) {
      const day = Math.floor(klines[i].openTime / DAY_MS);
      out.set(day, Math.log(cur / prev));
    }
  }
  return out;
}

/** Pearson correlation trên các ngày CHUNG của 2 chuỗi return. null nếu overlap < minOverlap. */
function pairCorr(a: Map<number, number>, b: Map<number, number>, minOverlap: number): number | null {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let n = 0;
  let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
  for (const [day, x] of small) {
    const y = large.get(day);
    if (y === undefined) continue;
    n++; sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y;
  }
  if (n < minOverlap) return null;
  const cov = sxy - (sx * sy) / n;
  const vx = sxx - (sx * sx) / n;
  const vy = syy - (sy * sy) / n;
  if (vx <= 0 || vy <= 0) return null;
  return cov / Math.sqrt(vx * vy);
}

/**
 * Gom cụm: trả Map<symbol, clusterId>. Symbol không đủ dữ liệu -> cụm riêng.
 */
export function computeCorrelationClusters(
  dailyBySymbol: Map<string, Kline[]>,
  threshold = 0.8,
  minOverlap = 60
): Map<string, number> {
  const symbols = [...dailyBySymbol.keys()];
  const rets = symbols.map((s) => dailyReturns(dailyBySymbol.get(s)!));

  // Union-find
  const parent = symbols.map((_, i) => i);
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };

  for (let i = 0; i < symbols.length; i++) {
    for (let j = i + 1; j < symbols.length; j++) {
      const c = pairCorr(rets[i], rets[j], minOverlap);
      if (c !== null && c >= threshold) union(i, j);
    }
  }

  // Chuẩn hóa root -> id tuần tự
  const rootToId = new Map<number, number>();
  const clusterOf = new Map<string, number>();
  for (let i = 0; i < symbols.length; i++) {
    const r = find(i);
    let id = rootToId.get(r);
    if (id === undefined) {
      id = rootToId.size;
      rootToId.set(r, id);
    }
    clusterOf.set(symbols[i], id);
  }
  return clusterOf;
}

/** Số cụm phân biệt (để log/hiển thị). */
export function clusterCount(clusterOf: Map<string, number>): number {
  return new Set(clusterOf.values()).size;
}
