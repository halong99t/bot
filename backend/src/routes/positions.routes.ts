import { Router } from "express";
import { prisma } from "../config/prisma";
import { closePosition } from "../services/trading.service";
import { asyncHandler } from "../middleware/error";

const router = Router();

router.get(
  "/",
  asyncHandler(async (req, res) => {
    const status = (req.query.status as string) ?? "OPEN";
    const positions = await prisma.position.findMany({
      where: { status: status as any },
      orderBy: { openedAt: "desc" },
    });
    res.json(positions);
  })
);

// Đóng lệnh thủ công theo giá hiện tại
router.post(
  "/:id/close",
  asyncHandler(async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const pos = await prisma.position.findUnique({ where: { id } });
    if (!pos) return res.status(404).json({ error: "Position not found" });
    const exitPrice = pos.currentPrice ?? pos.entryPrice;
    await closePosition(id, exitPrice, "MANUAL");
    res.json({ ok: true });
  })
);

export default router;
