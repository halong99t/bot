import fs from "fs";
import path from "path";
import * as parquet from "@dsnp/parquetjs";
import { binance } from "../lib/binance";
import { env } from "../config/env";
import { logger } from "../lib/logger";

/**
 * Kéo dữ liệu nến 1m ĐẦY ĐỦ từ Binance Futures (USDT-M) về, lưu thành file parquet
 * trong thư mục /1m — CÙNG ĐỊNH DẠNG với dataset có sẵn để tích hợp thẳng vào
 * universe/backtest/chart (không phải build lại pipeline).
 *
 * Schema parquet (khớp file cũ): ts INT64, open/high/low/close/volume DOUBLE (PLAIN, uncompressed).
 * Tên file: `${BASE}_USDT-USDT.parquet` (BASE = symbol bỏ đuôi USDT) — khớp symbolFromFile().
 *
 * Kéo theo CỬA SỔ thời gian (mặc định 10 ngày ≈ 14.400 nến < giới hạn) rồi ghi dần vào
 * parquet để không giữ hàng triệu nến trong RAM.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const WINDOW_MS = 10 * DAY_MS; // 10 ngày/cửa sổ (~14.400 nến 1m)
// Binance USDT-M perp sớm nhất ~2019-09. Mặc định kéo full từ mốc này.
const DEFAULT_FROM = Date.UTC(2019, 8, 1);

const PARQUET_SCHEMA = new parquet.ParquetSchema({
  ts: { type: "INT64" },
  open: { type: "DOUBLE" },
  high: { type: "DOUBLE" },
  low: { type: "DOUBLE" },
  close: { type: "DOUBLE" },
  volume: { type: "DOUBLE" },
});

/** BASE (bỏ đuôi USDT) -> tên file parquet khớp symbolFromFile(). */
export function fileNameForSymbol(symbol: string): string {
  const s = symbol.toUpperCase();
  const base = s.endsWith("USDT") ? s.slice(0, -4) : s;
  return `${base}_USDT-USDT.parquet`;
}

export function localFileExists(symbol: string): boolean {
  return fs.existsSync(path.join(env.DATA_1M_DIR, fileNameForSymbol(symbol)));
}

/** Xóa cache resample cũ của symbol (khi tải mới/tải lại) để backtest build lại từ parquet mới. */
function invalidateCache(symbol: string): void {
  const cacheDir = path.join(env.DATA_1M_DIR, "_cache");
  for (const iv of ["1m", "15m", "1h", "4h", "1d"]) {
    const fp = path.join(cacheDir, `${symbol.toUpperCase()}__${iv}.json`);
    try {
      if (fs.existsSync(fp)) fs.unlinkSync(fp);
    } catch {
      /* bỏ qua */
    }
  }
}

export interface DownloadResult {
  symbol: string;
  ok: boolean;
  candles: number;
  from: number | null;
  to: number | null;
  error?: string;
}

/**
 * Kéo full 1m history của 1 symbol futures -> ghi parquet vào /1m.
 * onProgress(pct 0..1) để cập nhật job.
 */
export async function downloadFuturesSymbol1m(
  symbol: string,
  opts: { fromMs?: number; toMs?: number; onProgress?: (pct: number) => void } = {}
): Promise<DownloadResult> {
  const sym = symbol.toUpperCase();
  const fromMs = opts.fromMs ?? DEFAULT_FROM;
  const toMs = opts.toMs ?? Date.now();
  const dir = env.DATA_1M_DIR;
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const finalPath = path.join(dir, fileNameForSymbol(sym));
  const tmpPath = finalPath + ".tmp";

  let writer: any = null;
  let total = 0;
  let minTs: number | null = null;
  let maxTs: number | null = null;

  try {
    writer = await parquet.ParquetWriter.openFile(PARQUET_SCHEMA, tmpPath);
    const span = Math.max(1, toMs - fromMs);

    for (let winStart = fromMs; winStart < toMs; winStart += WINDOW_MS) {
      const winEnd = Math.min(winStart + WINDOW_MS, toMs);
      // getKlinesRange tự phân trang trong cửa sổ (≤ ~14.400 nến < hardCap 20.000).
      const klines = await binance.getKlinesRange(sym, "1m", winStart, winEnd - 1);
      for (const k of klines) {
        await writer.appendRow({
          ts: k.openTime,
          open: k.open,
          high: k.high,
          low: k.low,
          close: k.close,
          volume: k.volume,
        });
        if (minTs === null || k.openTime < minTs) minTs = k.openTime;
        if (maxTs === null || k.openTime > maxTs) maxTs = k.openTime;
        total++;
      }
      opts.onProgress?.(Math.min(1, (winEnd - fromMs) / span));
    }

    await writer.close();
    writer = null;

    if (total === 0) {
      // Không có dữ liệu (symbol không tồn tại trên futures) -> xóa file rỗng.
      try {
        if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
      } catch {
        /* ignore */
      }
      return { symbol: sym, ok: false, candles: 0, from: null, to: null, error: "Không có dữ liệu (symbol không có trên Futures?)" };
    }

    // Thay thế nguyên tử: xóa file cũ (nếu tải lại) rồi rename tmp -> final.
    try {
      if (fs.existsSync(finalPath)) fs.unlinkSync(finalPath);
    } catch {
      /* ignore */
    }
    fs.renameSync(tmpPath, finalPath);
    invalidateCache(sym);

    logger.info("strategy", `Tải ${sym}: ${total} nến 1m (${new Date(minTs!).toISOString().slice(0, 10)} → ${new Date(maxTs!).toISOString().slice(0, 10)})`);
    return { symbol: sym, ok: true, candles: total, from: minTs, to: maxTs };
  } catch (err) {
    try {
      if (writer) await writer.close();
    } catch {
      /* ignore */
    }
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {
      /* ignore */
    }
    logger.warn("strategy", `Tải ${sym} lỗi: ${String(err)}`);
    return { symbol: sym, ok: false, candles: 0, from: null, to: null, error: String(err) };
  }
}

/**
 * Kéo nhiều symbol tuần tự (tránh rate-limit). onProgress(doneSymbols, total, current, pctOfCurrent).
 */
export async function downloadMany(
  symbols: string[],
  opts: {
    fromMs?: number;
    toMs?: number;
    onProgress?: (done: number, total: number, current: string, pct: number) => void;
  } = {}
): Promise<DownloadResult[]> {
  const out: DownloadResult[] = [];
  const uniq = [...new Set(symbols.map((s) => s.toUpperCase()))];
  for (let i = 0; i < uniq.length; i++) {
    const sym = uniq[i];
    const r = await downloadFuturesSymbol1m(sym, {
      fromMs: opts.fromMs,
      toMs: opts.toMs,
      onProgress: (pct) => opts.onProgress?.(i, uniq.length, sym, pct),
    });
    out.push(r);
    opts.onProgress?.(i + 1, uniq.length, sym, 1);
  }
  return out;
}

// Rổ coin vốn hóa lớn (majors) — ưu tiên lấp cho regime & test blue-chip. BTC/ETH thiếu trong dataset.
export const MAJORS = [
  "BTCUSDT", "ETHUSDT", "BNBUSDT", "SOLUSDT", "XRPUSDT", "DOGEUSDT", "ADAUSDT",
  "TRXUSDT", "AVAXUSDT", "LINKUSDT", "DOTUSDT", "MATICUSDT", "LTCUSDT", "BCHUSDT",
];
