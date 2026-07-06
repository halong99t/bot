import { Request, Response, NextFunction } from "express";
import { BinanceError } from "../lib/binance";
import { logger } from "../lib/logger";

export function notFound(_req: Request, res: Response) {
  res.status(404).json({ error: "Not found" });
}

export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction
) {
  if (err instanceof BinanceError) {
    logger.error("binance", `Binance error trả về API: ${err.message}`, { code: err.code });
    return res.status(502).json({
      error: "Binance API error",
      message: err.message,
      code: err.code,
    });
  }
  const message = err instanceof Error ? err.message : "Internal server error";
  logger.error("system", `Unhandled error: ${message}`);
  res.status(500).json({ error: "Internal server error", message });
}

/** Bọc async handler để bắt lỗi tự động */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>
) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res, next).catch(next);
  };
}
