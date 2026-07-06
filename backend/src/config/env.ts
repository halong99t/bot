import dotenv from "dotenv";
import path from "path";

dotenv.config();

// Thư mục 1m mặc định = <project-root>/1m (env.ts nằm ở backend/src/config)
const DEFAULT_DATA_1M_DIR = path.resolve(__dirname, "../../../1m");

function bool(v: string | undefined, def = false): boolean {
  if (v === undefined) return def;
  return v.toLowerCase() === "true" || v === "1";
}

export const env = {
  NODE_ENV: process.env.NODE_ENV ?? "development",
  PORT: parseInt(process.env.PORT ?? "4000", 10),
  DATABASE_URL: process.env.DATABASE_URL ?? "",
  JWT_SECRET: process.env.JWT_SECRET ?? "change_me",

  BINANCE_API_KEY: process.env.BINANCE_API_KEY ?? "",
  BINANCE_API_SECRET: process.env.BINANCE_API_SECRET ?? "",
  BINANCE_TESTNET: bool(process.env.BINANCE_TESTNET, true),

  SCAN_INTERVAL_MS: parseInt(process.env.SCAN_INTERVAL_MS ?? "60000", 10),

  // Thư mục chứa file parquet nến 1m (dữ liệu lịch sử của người dùng)
  DATA_1M_DIR: process.env.DATA_1M_DIR ?? DEFAULT_DATA_1M_DIR,
};
