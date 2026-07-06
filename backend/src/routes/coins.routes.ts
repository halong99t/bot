import { Router } from "express";
import { prisma } from "../config/prisma";
import { binance } from "../lib/binance";
import { getRankings } from "../services/scanner.service";
import { computeIndicators } from "../services/indicators";
import { asyncHandler } from "../middleware/error";

const router = Router();

// Danh sách coin + market_data mới nhất (cho Market Scanner)
router.get(
  "/",
  asyncHandler(async (_req, res) => {
    const { all } = await getRankings();
    res.json(all);
  })
);

// Bảng xếp hạng
router.get(
  "/rankings",
  asyncHandler(async (_req, res) => {
    res.json(await getRankings());
  })
);

// Klines cho chart (proxy Binance) + chỉ báo
router.get(
  "/:symbol/klines",
  asyncHandler(async (req, res) => {
    const { symbol } = req.params;
    const interval = (req.query.interval as string) ?? "15m";
    const limit = Math.min(parseInt((req.query.limit as string) ?? "300", 10), 1000);
    const klines = await binance.getKlines(symbol.toUpperCase(), interval, limit);
    const indicators = computeIndicators(klines);
    res.json({ symbol: symbol.toUpperCase(), interval, klines, indicators });
  })
);

// Lịch sử market_data của 1 symbol
router.get(
  "/:symbol/history",
  asyncHandler(async (req, res) => {
    const rows = await prisma.marketData.findMany({
      where: { symbol: req.params.symbol.toUpperCase() },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
    res.json(rows);
  })
);

export default router;
