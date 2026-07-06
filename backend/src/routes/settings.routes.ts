import { Router } from "express";
import { z } from "zod";
import { prisma } from "../config/prisma";
import { binance } from "../lib/binance";
import { getSettings } from "../services/trading.service";
import { getCurrentRegime, getRegimeSnapshot } from "../services/liveRegime.service";
import { asyncHandler } from "../middleware/error";

const router = Router();

// GET /api/settings/regime — regime BTC hiện tại (cho bot tự đánh TREND)
router.get(
  "/regime",
  asyncHandler(async (_req, res) => {
    const s = await getSettings();
    const side = await getCurrentRegime(s.regimeMode);
    const snap = getRegimeSnapshot();
    res.json({ side, close: snap?.close ?? null, ema: snap?.ema ?? null, interval: snap?.interval ?? null, at: snap?.at ?? null });
  })
);

const settingsSchema = z.object({
  takeProfitPct: z.number().positive().optional(),
  stopLossPct: z.number().positive().optional(),
  orderSizeUsdt: z.number().positive().optional(),
  leverage: z.number().int().min(1).max(125).optional(),
  marginMode: z.enum(["CROSS", "ISOLATED"]).optional(),
  tpSlMode: z.enum(["PRICE", "MARGIN"]).optional(),
  scanIntervalMs: z.number().int().min(10000).optional(),
  autoTrade: z.boolean().optional(),
  strategyMode: z.enum(["LONG", "TREND"]).optional(),
  regimeMode: z.literal("BTC1H_ALT1H").optional(),
  paperTrade: z.boolean().optional(),
  riskPerTradePct: z.number().min(0).max(20).optional(),
  binanceApiKey: z.string().optional(),
  binanceApiSecret: z.string().optional(),
});

router.get(
  "/",
  asyncHandler(async (_req, res) => {
    const s = await getSettings();
    // Không trả secret ra ngoài, chỉ báo đã cấu hình hay chưa
    res.json({
      ...s,
      binanceApiKey: s.binanceApiKey ? maskKey(s.binanceApiKey) : "",
      binanceApiSecret: s.binanceApiSecret ? "********" : "",
      hasCredentials: Boolean(s.binanceApiKey && s.binanceApiSecret),
    });
  })
);

router.put(
  "/",
  asyncHandler(async (req, res) => {
    const data = settingsSchema.parse(req.body);
    const current = await getSettings();

    // Nếu secret là placeholder thì giữ nguyên giá trị cũ
    if (data.binanceApiSecret === "********") delete data.binanceApiSecret;
    if (data.binanceApiKey && data.binanceApiKey.includes("*")) delete data.binanceApiKey;

    const updated = await prisma.settings.update({
      where: { id: current.id },
      data,
    });

    if (updated.binanceApiKey || updated.binanceApiSecret) {
      binance.setCredentials(updated.binanceApiKey, updated.binanceApiSecret);
    }

    res.json({ ok: true });
  })
);

function maskKey(k: string) {
  if (k.length <= 8) return "****";
  return `${k.slice(0, 4)}****${k.slice(-4)}`;
}

export default router;
