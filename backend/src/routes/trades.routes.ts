import { Router } from "express";
import { prisma } from "../config/prisma";
import { asyncHandler } from "../middleware/error";

const router = Router();

router.get(
  "/",
  asyncHandler(async (req, res) => {
    const limit = Math.min(parseInt((req.query.limit as string) ?? "200", 10), 1000);
    const trades = await prisma.trade.findMany({
      orderBy: { closedAt: "desc" },
      take: limit,
    });
    res.json(trades);
  })
);

export default router;
