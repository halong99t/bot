import { env } from "../config/env";
import { logger } from "../lib/logger";
import { runScanCycle, syncCoins, getScannerState } from "../services/scanner.service";
import { getSettings } from "../services/trading.service";

/**
 * Scheduler: scan liên tục mỗi N mili-giây (mặc định 60s = 1 phút).
 * Interval lấy từ Settings DB (ưu tiên) -> fallback ENV.
 * Chống chạy chồng: nếu chu kỳ trước chưa xong thì bỏ qua nhịp này.
 */

let timer: NodeJS.Timeout | null = null;
let running = false;

export async function startScheduler() {
  // Đồng bộ coin lúc khởi động (retry vài lần nếu Binance lỗi)
  await safeSyncCoins();

  // Đồng bộ lại danh sách coin mỗi 6 giờ
  setInterval(() => void safeSyncCoins(), 6 * 60 * 60 * 1000);

  const schedule = async () => {
    const settings = await getSettings().catch(() => null);
    const interval = settings?.scanIntervalMs ?? env.SCAN_INTERVAL_MS;

    if (timer) clearInterval(timer);
    timer = setInterval(() => void tick(), interval);
    logger.info("system", `Scheduler chạy mỗi ${interval}ms`);
  };

  await schedule();
  // Chạy ngay 1 lần đầu
  void tick();
}

async function tick() {
  if (running) {
    logger.warn("scanner", "Chu kỳ trước chưa xong, bỏ qua nhịp này");
    return;
  }
  running = true;
  try {
    await runScanCycle();
  } finally {
    running = false;
  }
}

async function safeSyncCoins(attempt = 1): Promise<void> {
  try {
    await syncCoins();
  } catch (err) {
    if (attempt <= 3) {
      const wait = attempt * 5000;
      logger.warn("scanner", `syncCoins lỗi, retry sau ${wait}ms`, { attempt });
      await new Promise((r) => setTimeout(r, wait));
      return safeSyncCoins(attempt + 1);
    }
    logger.error("scanner", `syncCoins thất bại sau ${attempt} lần: ${String(err)}`);
  }
}

export { getScannerState };
