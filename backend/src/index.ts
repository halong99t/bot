import http from "http";
import { createApp } from "./app";
import { env } from "./config/env";
import { connectDb, disconnectDb } from "./config/prisma";
import { initWebSocket } from "./websocket/ws.server";
import { startScheduler } from "./jobs/scheduler";
import { buildAllCache } from "./services/backtest.service";
import { logger } from "./lib/logger";

async function main() {
  await connectDb();
  logger.info("system", "Đã kết nối PostgreSQL");

  const app = createApp();
  const server = http.createServer(app);

  initWebSocket(server);

  server.listen(env.PORT, () => {
    logger.info("system", `Backend chạy tại http://localhost:${env.PORT} (env=${env.NODE_ENV})`);
  });

  // Khởi động scheduler scan coin (không chặn server start)
  startScheduler().catch((e) => logger.error("system", `Scheduler lỗi khởi động: ${String(e)}`));

  // Tự build cache nến (đọc parquet 1 lần) chạy nền để backtest sau này nhanh
  buildAllCache().catch((e) => logger.error("system", `Build cache nền lỗi: ${String(e)}`));

  const shutdown = async (sig: string) => {
    logger.info("system", `Nhận ${sig}, đang tắt...`);
    server.close();
    await disconnectDb();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  // Không để 1 lỗi không bắt được làm sập cả bot
  process.on("unhandledRejection", (reason) => {
    logger.error("system", `Unhandled rejection: ${String(reason)}`);
  });
}

main().catch((err) => {
  logger.error("system", `Khởi động thất bại: ${String(err)}`);
  process.exit(1);
});
