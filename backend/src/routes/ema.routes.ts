import { Router } from "express";
import { z } from "zod";
import { classifySeries } from "../services/emaClassifier.service";
import lookup from "../services/ema-classifier.lookup.json";
import {
  runEmaLocal1mBacktest,
  EmaBacktestParams,
  listLocal1mSymbols,
  getLocalSeriesForSymbol,
} from "../services/backtest.service";
import { createJob, getJob, updateJob } from "../jobs/backtestJobs";
import { logger } from "../lib/logger";
import { asyncHandler } from "../middleware/error";

const router = Router();

// GET /api/ema/states — bảng tra 6 trạng thái (tham chiếu cho UI)
router.get(
  "/states",
  asyncHandler(async (_req, res) => {
    res.json(lookup);
  })
);

const classifyQuery = z.object({
  symbol: z.string().min(1),
  interval: z.enum(["15m", "1h", "4h", "1d"]).optional(),
  fast: z.coerce.number().int().min(1).optional(),
  slow: z.coerce.number().int().min(2).optional(),
  epsilonMode: z.enum(["atr", "percent", "absolute"]).optional(),
  epsilonValue: z.coerce.number().min(0).optional(),
  atrPeriod: z.coerce.number().int().min(1).optional(),
});

/**
 * GET /api/ema/classify — phân loại state mới nhất của 1 symbol từ DỮ LIỆU 1M LOCAL.
 * Trả state nến cuối + vài nến gần nhất để hiển thị (không dùng mạng Binance).
 */
router.get(
  "/classify",
  asyncHandler(async (req, res) => {
    const q = classifyQuery.parse(req.query);
    const interval = q.interval ?? "1h";
    const fastPeriod = q.fast ?? 9;
    const slowPeriod = q.slow ?? 21;
    if (fastPeriod >= slowPeriod) {
      return res.status(400).json({ message: "fast phải nhỏ hơn slow" });
    }
    const klines = await getLocalSeriesForSymbol(q.symbol.toUpperCase(), interval);
    if (!klines.length) {
      return res
        .status(404)
        .json({ message: `Không có dữ liệu 1m local cho ${q.symbol.toUpperCase()}` });
    }
    const series = classifySeries(klines, {
      fastPeriod,
      slowPeriod,
      epsilonMode: q.epsilonMode,
      epsilonValue: q.epsilonValue,
      atrPeriod: q.atrPeriod,
    });
    // Dữ liệu local là nến lịch sử đã đóng -> nến cuối là mới nhất.
    const current = series[series.length - 1];
    const recent = series.slice(-20).map((c) => ({
      timestamp: new Date(c.openTime).toISOString(),
      openTime: c.openTime,
      close: c.close,
      fast: Number.isFinite(c.fast) ? c.fast : null,
      slow: Number.isFinite(c.slow) ? c.slow : null,
      state: c.cls.state,
      bias: c.cls.bias,
      structure: c.cls.structure,
      alignment: c.cls.alignment,
      risk: c.cls.risk,
      is_signal: c.isSignal,
    }));
    res.json({
      symbol: q.symbol.toUpperCase(),
      interval,
      fastPeriod,
      slowPeriod,
      current: current
        ? {
            timestamp: new Date(current.openTime).toISOString(),
            close: current.close,
            fast: Number.isFinite(current.fast) ? current.fast : null,
            slow: Number.isFinite(current.slow) ? current.slow : null,
            state: current.cls.state,
            bias: current.cls.bias,
            structure: current.cls.structure,
            alignment: current.cls.alignment,
            risk: current.cls.risk,
            is_signal: current.isSignal,
          }
        : null,
      recent,
    });
  })
);

const backtestSchema = z.object({
  symbols: z.array(z.string()).optional(),
  interval: z.enum(["15m", "1h", "4h", "1d"]).optional(),
  fromMs: z.number().int().positive().optional(),
  toMs: z.number().int().positive().optional(),
  fastPeriod: z.number().int().min(1).optional(),
  slowPeriod: z.number().int().min(2).optional(),
  epsilonMode: z.enum(["atr", "percent", "absolute"]).optional(),
  epsilonValue: z.number().min(0).optional(),
  atrPeriod: z.number().int().min(1).optional(),
  direction: z.enum(["LONG", "SHORT", "BOTH"]).optional(),
  entryStates: z.array(z.string()).optional(),
  takeProfitPct: z.number().positive().optional(),
  stopLossPct: z.number().positive().optional(),
  initialCapitalUsdt: z.number().positive().optional(),
  orderSizeUsdt: z.number().positive().optional(),
  positionSizePct: z.number().min(0).max(100).optional(),
  leverage: z.number().min(1).max(125).optional(),
  marginMode: z.enum(["CROSS", "ISOLATED"]).optional(),
  tpSlMode: z.enum(["PRICE", "MARGIN"]).optional(),
  maxConcurrentPositions: z.number().int().min(0).max(500).optional(),
  // ----- v1.1 chiến thuật TP/SL theo alignment -----
  exitStrategy: z.enum(["simple", "alignment"]).optional(),
  riskPerTradePct: z.number().min(0).max(100).optional(),
  riskCompound: z.boolean().optional(),
  maxPortfolioRiskPct: z.number().min(0).max(1000).optional(),
  feePct: z.number().min(0).max(5).optional(),
  slippagePct: z.number().min(0).max(5).optional(),
  monthlyReset: z.boolean().optional(),
  swingLookback: z.number().int().min(1).max(200).optional(),
  emaBufferAtr: z.number().min(0).max(10).optional(),
  slAnchor: z.enum(["atr", "structure", "protective"]).optional(),
  slAtrMult: z.number().min(0).max(20).optional(),
  globalExitOverlay: z.boolean().optional(),
  hardExit: z.boolean().optional(),
});

/**
 * POST /api/ema/backtest/local — backtest EMA classifier trên dữ liệu 1m local, chạy nền.
 * Trả { jobId }. Theo dõi qua GET /api/backtest/jobs/:id (dùng chung job store).
 */
router.post(
  "/backtest/local",
  asyncHandler(async (req, res) => {
    const params = backtestSchema.parse(req.body ?? {}) as EmaBacktestParams;
    if ((params.fastPeriod ?? 9) >= (params.slowPeriod ?? 21)) {
      return res.status(400).json({ message: "fastPeriod phải nhỏ hơn slowPeriod" });
    }
    const all = listLocal1mSymbols();
    const total =
      params.symbols && params.symbols.length
        ? params.symbols.filter((s) => all.includes(s.toUpperCase())).length
        : all.length;
    const job = createJob(total || all.length);

    runEmaLocal1mBacktest(params, (d, t, symbol) => {
      updateJob(job.id, { progress: d, total: t, currentSymbol: symbol });
    })
      .then((result) => {
        updateJob(job.id, { status: "done", result, finishedAt: Date.now() });
        logger.info("strategy", `Backtest EMA LOCAL xong: ${result.totalTrades} lệnh`);
      })
      .catch((err) => {
        updateJob(job.id, { status: "error", error: String(err), finishedAt: Date.now() });
        logger.error("strategy", `Backtest EMA LOCAL lỗi: ${String(err)}`);
      });

    res.json({ jobId: job.id, total });
  })
);

// GET /api/ema/backtest/jobs/:id — alias tiện cho frontend (job store dùng chung)
router.get(
  "/backtest/jobs/:id",
  asyncHandler(async (req, res) => {
    const job = getJob(req.params.id);
    if (!job) return res.status(404).json({ error: "Job not found" });
    res.json(job);
  })
);

export default router;
