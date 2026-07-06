import { Router } from "express";
import { prisma } from "../config/prisma";
import { getScannerState } from "../services/scanner.service";
import { asyncHandler } from "../middleware/error";

const router = Router();

// Tổng quan Dashboard
router.get(
  "/",
  asyncHandler(async (_req, res) => {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);

    const [coinCount, pendingSignals, openPositions, todayTrades] = await Promise.all([
      prisma.coin.count({ where: { active: true } }),
      prisma.signal.count({ where: { status: "PENDING" } }),
      prisma.position.count({ where: { status: "OPEN" } }),
      prisma.trade.findMany({ where: { closedAt: { gte: startOfDay } } }),
    ]);

    const todayPnl = todayTrades.reduce((sum, t) => sum + t.pnl, 0);
    const winCount = todayTrades.filter((t) => t.pnl > 0).length;
    const winRate = todayTrades.length ? (winCount / todayTrades.length) * 100 : 0;
    const scanner = getScannerState();

    res.json({
      coinsScanning: coinCount,
      longSignals: pendingSignals,
      openPositions,
      todayPnl,
      todayTradeCount: todayTrades.length,
      winRate,
      lastScanAt: scanner.lastScanAt,
    });
  })
);

// Logs gần đây
router.get(
  "/logs",
  asyncHandler(async (req, res) => {
    const scope = req.query.scope as string | undefined;
    const logs = await prisma.log.findMany({
      where: scope ? { scope } : undefined,
      orderBy: { createdAt: "desc" },
      take: 200,
    });
    res.json(logs);
  })
);

export default router;
