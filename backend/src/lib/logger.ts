import { prisma } from "../config/prisma";

type Level = "info" | "warn" | "error";
type Scope = "scanner" | "strategy" | "trading" | "binance" | "system" | "ws";

function ts() {
  return new Date().toISOString();
}

async function persist(level: Level, scope: Scope, message: string, meta?: unknown) {
  try {
    await prisma.log.create({
      data: { level, scope, message, meta: meta ? JSON.stringify(meta) : undefined },
    });
  } catch {
    // Không để việc ghi log làm crash app
  }
}

export const logger = {
  info(scope: Scope, message: string, meta?: unknown) {
    console.log(`[${ts()}] [INFO] [${scope}] ${message}`);
    void persist("info", scope, message, meta);
  },
  warn(scope: Scope, message: string, meta?: unknown) {
    console.warn(`[${ts()}] [WARN] [${scope}] ${message}`);
    void persist("warn", scope, message, meta);
  },
  error(scope: Scope, message: string, meta?: unknown) {
    console.error(`[${ts()}] [ERROR] [${scope}] ${message}`);
    void persist("error", scope, message, meta);
  },
};
