import { Router } from "express";
import { prisma } from "../config/prisma";
import { openLongFromSignal } from "../services/trading.service";
import { asyncHandler } from "../middleware/error";

const router = Router();

router.get(
  "/",
  asyncHandler(async (req, res) => {
    const status = req.query.status as string | undefined;
    const signals = await prisma.signal.findMany({
      where: status ? { status: status as any } : undefined,
      orderBy: { detectedAt: "desc" },
      take: 100,
    });
    res.json(signals);
  })
);

// Thực thi 1 signal thủ công (đặt LONG ngay)
router.post(
  "/:id/execute",
  asyncHandler(async (req, res) => {
    const id = parseInt(req.params.id, 10);
    await openLongFromSignal(id);
    const signal = await prisma.signal.findUnique({ where: { id } });
    res.json(signal);
  })
);

router.post(
  "/:id/cancel",
  asyncHandler(async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const signal = await prisma.signal.update({
      where: { id },
      data: { status: "CANCELLED" },
    });
    res.json(signal);
  })
);

export default router;
