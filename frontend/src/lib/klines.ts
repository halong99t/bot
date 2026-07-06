import type { Kline } from "../types";

const INTERVAL_MS: Record<string, number> = {
  "1m": 60_000,
  "15m": 15 * 60_000,
  "1h": 60 * 60_000,
  "4h": 4 * 60 * 60_000,
  "1d": 24 * 60 * 60_000,
};

/** Chuẩn hóa mốc thời gian về ms */
function toMs(v: string | number): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!isNaN(n)) {
    if (n > 1e15) return Math.floor(n / 1000); // micro -> ms
    if (n > 1e12) return n; // ms
    if (n > 1e9) return n * 1000; // giây -> ms
  }
  const p = Date.parse(String(v));
  return isNaN(p) ? 0 : p;
}

/**
 * Parse CSV thành mảng nến 1m.
 * Hỗ trợ:
 *  - Có header: nhận cột time/openTime/timestamp/date, open, high, low, close, volume.
 *  - Không header: định dạng kline Binance [openTime, open, high, low, close, volume, ...].
 */
export function parseCsvToKlines(text: string): Kline[] {
  const lines = text.trim().split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return [];

  const firstCells = lines[0].split(/[,;\t]/);
  const firstIsNumber = !isNaN(Number(firstCells[0]));

  let idx = { t: 0, o: 1, h: 2, l: 3, c: 4, v: 5 };
  let startRow = 0;

  if (!firstIsNumber) {
    // Có header -> map theo tên cột
    const header = firstCells.map((h) => h.trim().toLowerCase());
    const find = (names: string[]) => header.findIndex((h) => names.includes(h));
    idx = {
      t: find(["opentime", "time", "timestamp", "date", "datetime"]),
      o: find(["open"]),
      h: find(["high"]),
      l: find(["low"]),
      c: find(["close"]),
      v: find(["volume", "vol"]),
    };
    startRow = 1;
    if (idx.o < 0 || idx.c < 0) return []; // thiếu cột bắt buộc
  }

  const out: Kline[] = [];
  for (let i = startRow; i < lines.length; i++) {
    const cells = lines[i].split(/[,;\t]/);
    const openTime = toMs(cells[idx.t]);
    const open = Number(cells[idx.o]);
    const high = Number(cells[idx.h]);
    const low = Number(cells[idx.l]);
    const close = Number(cells[idx.c]);
    const volume = idx.v >= 0 ? Number(cells[idx.v]) || 0 : 0;
    if (!openTime || isNaN(open) || isNaN(close)) continue;
    out.push({ openTime, open, high, low, close, volume, closeTime: openTime + 60_000 - 1 });
  }
  out.sort((a, b) => a.openTime - b.openTime);
  return out;
}

/** Gộp nến 1m thành khung lớn hơn (15m/1h/4h/1d) */
export function resample(klines1m: Kline[], interval: string): Kline[] {
  const ms = INTERVAL_MS[interval];
  if (!ms || ms === INTERVAL_MS["1m"]) return klines1m;

  const buckets = new Map<number, Kline>();
  for (const k of klines1m) {
    const bucketStart = Math.floor(k.openTime / ms) * ms;
    const b = buckets.get(bucketStart);
    if (!b) {
      buckets.set(bucketStart, {
        openTime: bucketStart,
        open: k.open,
        high: k.high,
        low: k.low,
        close: k.close,
        volume: k.volume,
        closeTime: bucketStart + ms - 1,
      });
    } else {
      b.high = Math.max(b.high, k.high);
      b.low = Math.min(b.low, k.low);
      b.close = k.close; // nến 1m đã sort tăng dần -> close cuối cùng
      b.volume += k.volume;
    }
  }
  return [...buckets.values()].sort((a, b) => a.openTime - b.openTime);
}
