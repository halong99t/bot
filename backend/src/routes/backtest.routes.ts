import { Router } from "express";
import { z } from "zod";
import {
  runBacktest,
  runFullExchangeBacktest,
  runImportedBacktest,
  runLocal1mBacktest,
  runTrendLocal1mBacktest,
  runRouterLocal1mBacktest,
  runTrendGrid,
  runMeanRevLocal1mBacktest,
  runMeanRevGrid,
  listLocal1mSymbols,
  buildCache,
  cacheStatus,
  getCacheBuildProgress,
  getLocalDataRange,
  getLocalKlinesForChart,
  getLocalSymbolRange,
  listFlaggedSymbols,
} from "../services/backtest.service";
import { computeIndicators } from "../services/indicators";
import { getRegimeKlines, buildRegimeSeries } from "../services/regime.service";
import { downloadMany, localFileExists, MAJORS } from "../services/dataDownload.service";
import { createJob, getJob, updateJob } from "../jobs/backtestJobs";
import { logger } from "../lib/logger";
import { prisma } from "../config/prisma";
import { asyncHandler } from "../middleware/error";
import {
  saveBacktestHistory,
  listBacktestHistory,
  getBacktestHistory,
  deleteBacktestHistory,
  clearBacktestHistory,
} from "../services/backtestHistory.service";

const router = Router();

const schema = z.object({
  symbols: z.array(z.string()).optional(),
  months: z.number().min(1).max(12).optional(),
  fromMs: z.number().int().positive().optional(),
  toMs: z.number().int().positive().optional(),
  interval: z.enum(["15m", "1h", "4h", "1d"]).optional(),
  takeProfitPct: z.number().positive().optional(),
  stopLossPct: z.number().positive().optional(),
  maxSymbols: z.number().int().min(1).max(30).optional(),
  initialCapitalUsdt: z.number().positive().optional(),
  orderSizeUsdt: z.number().positive().optional(),
  positionSizePct: z.number().min(0).max(100).optional(),
  leverage: z.number().min(1).max(125).optional(),
  marginMode: z.enum(["CROSS", "ISOLATED"]).optional(),
  tpSlMode: z.enum(["PRICE", "MARGIN"]).optional(),
  maxConcurrentPositions: z.number().int().min(0).max(500).optional(),
  feePct: z.number().min(0).max(5).optional(),
  slippagePct: z.number().min(0).max(5).optional(),
  fundingRatePctPer8h: z.number().min(0).max(1).optional(),
  useRealFunding: z.boolean().optional(),
  monthlyReset: z.boolean().optional(),
  minDropPct: z.number().positive().optional(),
  minSidewayCandles: z.number().int().positive().optional(),
  maxSidewayRangePct: z.number().positive().optional(),
  minRisePct: z.number().positive().optional(),
});

// POST /api/backtest — backtest đồng bộ (vài symbol, mặc định 3 tháng, nến 15m)
router.post(
  "/",
  asyncHandler(async (req, res) => {
    const params = schema.parse(req.body ?? {});
    const result = await runBacktest(params);
    res.json(result);
  })
);

/**
 * POST /api/backtest/all — backtest TOÀN SÀN, chạy nền.
 * Trả về ngay { jobId }. Theo dõi qua GET /api/backtest/jobs/:id.
 */
router.post(
  "/all",
  asyncHandler(async (req, res) => {
    const params = schema.parse(req.body ?? {});
    // Mặc định trần 50 vị thế đồng thời nếu không truyền
    if (params.maxConcurrentPositions === undefined) params.maxConcurrentPositions = 50;

    const total = await prisma.coin.count({ where: { active: true } });
    const job = createJob(total);

    // Chạy nền (không await)
    runFullExchangeBacktest(params, (done, t, symbol) => {
      updateJob(job.id, { progress: done, total: t, currentSymbol: symbol });
    })
      .then((result) => {
        updateJob(job.id, { status: "done", result, finishedAt: Date.now(), progress: total });
        logger.info("strategy", `Backtest toàn sàn xong: ${result.totalTrades} lệnh (bỏ ${result.skippedByCap} do trần)`);
      })
      .catch((err) => {
        updateJob(job.id, { status: "error", error: String(err), finishedAt: Date.now() });
        logger.error("strategy", `Backtest toàn sàn lỗi: ${String(err)}`);
      });

    res.json({ jobId: job.id, total });
  })
);

const klineSchema = z.object({
  openTime: z.number(),
  open: z.number(),
  high: z.number(),
  low: z.number(),
  close: z.number(),
  volume: z.number().optional().default(0),
  closeTime: z.number().optional().default(0),
});

const importSchema = schema.extend({
  data: z.array(z.object({ symbol: z.string(), candles: z.array(klineSchema) })).min(1),
});

// POST /api/backtest/imported — backtest trên dữ liệu nến do người dùng cung cấp (đã resample)
router.post(
  "/imported",
  asyncHandler(async (req, res) => {
    const body = importSchema.parse(req.body ?? {});
    const { data, ...params } = body;
    const result = runImportedBacktest(params, data as any);
    res.json(result);
  })
);

// GET /api/backtest/local/symbols — danh sách symbol có sẵn trong thư mục 1m
router.get(
  "/local/symbols",
  asyncHandler(async (_req, res) => {
    const symbols = listLocal1mSymbols();
    res.json({ count: symbols.length, symbols });
  })
);

// GET /api/backtest/local/:symbol/range — khoảng thời gian của 1 symbol (ms)
router.get(
  "/local/:symbol/range",
  asyncHandler(async (req, res) => {
    const range = await getLocalSymbolRange(req.params.symbol.toUpperCase());
    if (!range) return res.status(404).json({ message: `Không có dữ liệu local cho ${req.params.symbol}` });
    res.json(range);
  })
);

// GET /api/backtest/local/:symbol/klines?interval=1m&limit=&from=&to= — nến local cho chart
router.get(
  "/local/:symbol/klines",
  asyncHandler(async (req, res) => {
    const symbol = req.params.symbol.toUpperCase();
    const interval = (req.query.interval as string) ?? "1m";
    const limit = Math.min(parseInt((req.query.limit as string) ?? "5000", 10) || 5000, 20000);
    const from = req.query.from ? Number(req.query.from) : undefined;
    const to = req.query.to ? Number(req.query.to) : undefined;
    const klines = await getLocalKlinesForChart(symbol, interval, limit, from, to);
    if (!klines.length) return res.status(404).json({ message: `Không có dữ liệu local cho ${symbol}` });
    const indicators = computeIndicators(klines);
    res.json({ symbol, interval, klines, indicators });
  })
);

// GET /api/backtest/local/flagged — các symbol bị loại vì dữ liệu xấu (flatline/chết)
router.get(
  "/local/flagged",
  asyncHandler(async (_req, res) => {
    const flagged = listFlaggedSymbols();
    res.json({ count: flagged.length, flagged });
  })
);

// GET /api/backtest/local/range — khoảng thời gian thực của dữ liệu local
router.get(
  "/local/range",
  asyncHandler(async (_req, res) => {
    res.json((await getLocalDataRange()) ?? { minTs: 0, maxTs: 0 });
  })
);

// GET /api/backtest/local/cache-status?interval=1h — số coin đã có cache cho khung
router.get(
  "/local/cache-status",
  asyncHandler(async (req, res) => {
    const interval = (req.query.interval as string) ?? "1h";
    res.json({ ...cacheStatus(interval), ...getCacheBuildProgress() });
  })
);

// POST /api/backtest/local/cache — build cache cho 1 khung (chạy nền, 1 lần)
router.post(
  "/local/cache",
  asyncHandler(async (req, res) => {
    const interval = (req.body?.interval as string) ?? "1h";
    const total = listLocal1mSymbols().length;
    const job = createJob(total);
    buildCache(interval, (done, t, symbol) => {
      updateJob(job.id, { progress: done, total: t, currentSymbol: symbol });
    })
      .then(() => updateJob(job.id, { status: "done", finishedAt: Date.now() }))
      .catch((err) =>
        updateJob(job.id, { status: "error", error: String(err), finishedAt: Date.now() })
      );
    res.json({ jobId: job.id, total });
  })
);

// POST /api/backtest/local — backtest từ dữ liệu 1m local (parquet), chạy nền
router.post(
  "/local",
  asyncHandler(async (req, res) => {
    const params = schema.parse(req.body ?? {});
    const all = listLocal1mSymbols();
    const total =
      params.symbols && params.symbols.length
        ? params.symbols.filter((s) => all.includes(s.toUpperCase())).length
        : all.length;
    const job = createJob(total || all.length);

    runLocal1mBacktest(params, (done, t, symbol) => {
      updateJob(job.id, { progress: done, total: t, currentSymbol: symbol });
    })
      .then((result) => {
        updateJob(job.id, { status: "done", result, finishedAt: Date.now() });
        logger.info("strategy", `Backtest LOCAL xong: ${result.totalTrades} lệnh`);
      })
      .catch((err) => {
        updateJob(job.id, { status: "error", error: String(err), finishedAt: Date.now() });
        logger.error("strategy", `Backtest LOCAL lỗi: ${String(err)}`);
      });

    res.json({ jobId: job.id, total });
  })
);

// ===================== TREND FOLLOWING =====================

const trendSchema = schema.extend({
  // Tham số chiến lược trend
  dcEntry: z.number().int().min(10).max(400).optional(),
  dcExit: z.number().int().min(5).max(300).optional(),
  emaFast: z.number().int().min(2).max(200).optional(),
  emaSlow: z.number().int().min(3).max(400).optional(),
  emaTrend: z.number().int().min(20).max(500).optional(),
  adxPeriod: z.number().int().min(2).max(100).optional(),
  adxMin: z.number().min(0).max(60).optional(),
  atrPeriod: z.number().int().min(2).max(100).optional(),
  k1Atr: z.number().min(0.5).max(10).optional(),
  k2Atr: z.number().min(0.5).max(15).optional(),
  timeStopBars: z.number().int().min(10).max(5000).optional(),
  atrPctMin: z.number().min(0).max(50).optional(),
  atrPctMax: z.number().min(0).max(100).optional(),
  allowLong: z.boolean().optional(),
  allowShort: z.boolean().optional(),
  useRegimeExit: z.boolean().optional(),
  useDonchianExit: z.boolean().optional(), // tắt Donchian-exit rõ ràng (thay cho hack dcExit>dcEntry)
  cooldownBars: z.number().int().min(0).max(500).optional(), // [M2] nến chờ sau khi thoát
  // Logic filter: xác nhận breakout bằng nến follow-through (chống fake breakout, R1 forensics)
  confirmBars: z.number().int().min(0).max(10).optional(),
  confirmAtr: z.number().min(0).max(3).optional(),
  confirmSide: z.enum(["both", "short", "long"]).optional(),
  useLiquidation: z.boolean().optional(), // mô hình thanh lý theo đòn bẩy (mặc định bật)
  maintenanceMarginRatePct: z.number().min(0).max(5).optional(),
  // Phase 1: Entry Scorer + volume + break-even + partial TP
  useEntryScore: z.boolean().optional(),
  entryScoreMin: z.number().min(0).max(100).optional(),
  volLen: z.number().int().min(2).max(200).optional(),
  volMult: z.number().min(0).max(10).optional(),
  breakEvenR: z.number().min(0).max(10).optional(),
  partialTpR: z.number().min(0).max(20).optional(),
  partialTpFrac: z.number().min(0).max(1).optional(),
  dailyLossLimitPct: z.number().min(0).max(100).optional(),
  weeklyLossLimitPct: z.number().min(0).max(100).optional(),
  // Regime
  useRegime: z.boolean().optional(),
  regimeMode: z.enum(["BTC1H_ALT1H", "BTC1H_ALT15M"]).optional(),
  regimeSymbol: z.string().optional(),
  regimeEmaPeriod: z.number().int().min(10).max(400).optional(),
  regimeSource: z.enum(["local", "binance"]).optional(),
  useRegimeSlope: z.boolean().optional(),
  regimeSlopeLookback: z.number().int().min(2).max(200).optional(),
  useRegimeBreadth: z.boolean().optional(),
  regimeBreadthMin: z.number().min(0).max(1).optional(),
  topLiquidity: z.number().int().min(0).max(600).optional(),
  // Sizing R-based
  riskPerTradePct: z.number().min(0).max(20).optional(),
  maxPortfolioRiskPct: z.number().min(0).max(100).optional(),
  // Circuit breaker DD
  ddReducePct: z.number().min(0).max(100).optional(),
  ddReduceFactor: z.number().min(0).max(1).optional(),
  ddHaltPct: z.number().min(0).max(100).optional(),
  ddResumePct: z.number().min(0).max(100).optional(),
  // Correlation cluster cap
  useCorrelationCap: z.boolean().optional(),
  maxPerCluster: z.number().int().min(0).max(100).optional(),
  corrThreshold: z.number().min(0).max(1).optional(),
});

// [M1] Ràng buộc chéo tham số — chặn config vô nghĩa lọt qua range validation trước grid/backtest.
// Để TẮT Donchian-exit dùng cờ `useDonchianExit:false` (KHÔNG đặt dcExit > dcEntry như trước).
const crossFieldRefine = (v: Record<string, any>, ctx: z.RefinementCtx) => {
  const bad = (message: string, path: string) =>
    ctx.addIssue({ code: z.ZodIssueCode.custom, message, path: [path] });
  if (v.emaFast !== undefined && v.emaSlow !== undefined && v.emaFast >= v.emaSlow)
    bad("emaFast phải nhỏ hơn emaSlow", "emaFast");
  if (v.emaSlow !== undefined && v.emaTrend !== undefined && v.emaSlow >= v.emaTrend)
    bad("emaSlow phải nhỏ hơn emaTrend", "emaSlow");
  if (v.dcExit !== undefined && v.dcEntry !== undefined && v.dcExit > v.dcEntry)
    bad("dcExit phải ≤ dcEntry (muốn tắt Donchian-exit: dùng useDonchianExit=false)", "dcExit");
  if (v.atrPctMin !== undefined && v.atrPctMax !== undefined && v.atrPctMin >= v.atrPctMax)
    bad("atrPctMin phải nhỏ hơn atrPctMax", "atrPctMin");
};
const trendSchemaChecked = trendSchema.superRefine(crossFieldRefine);

/**
 * POST /api/backtest/trend/local — backtest TREND FOLLOWING trên dữ liệu 1m local, chạy nền.
 * Kéo BTC từ Binance (cache đĩa) để dựng regime filter. Trả { jobId }.
 */
router.post(
  "/trend/local",
  asyncHandler(async (req, res) => {
    const params = trendSchemaChecked.parse(req.body ?? {});
    const all = listLocal1mSymbols();
    const total =
      params.symbols && params.symbols.length
        ? params.symbols.filter((s) => all.includes(s.toUpperCase())).length
        : all.length;
    const job = createJob(total || all.length);

    runTrendLocal1mBacktest(params, (done, t, symbol) => {
      updateJob(job.id, { progress: done, total: t, currentSymbol: symbol });
    })
      .then((result) => {
        updateJob(job.id, { status: "done", result, finishedAt: Date.now() });
        logger.info("strategy", `Backtest TREND xong: ${result.totalTrades} lệnh (bỏ ${result.skippedByCap} do trần)`);
      })
      .catch((err) => {
        updateJob(job.id, { status: "error", error: String(err), finishedAt: Date.now() });
        logger.error("strategy", `Backtest TREND lỗi: ${String(err)}`);
      });

    res.json({ jobId: job.id, total });
  })
);

// ROUTER = trend + mean-rev. Kế thừa toàn bộ trendSchema, thêm 2 công tắc nhánh + override mean-rev.
const meanRevOverrideSchema = z
  .object({
    n: z.number().int().min(10).max(500).optional(),
    zEntry: z.number().min(0.5).max(6).optional(),
    zPartial: z.number().min(0).max(6).optional(),
    zTp: z.number().min(-3).max(3).optional(),
    zStop: z.number().min(1).max(10).optional(),
    kSl: z.number().min(0.2).max(10).optional(),
    timeStopBars: z.number().int().min(2).max(5000).optional(),
    adxMax: z.number().min(0).max(60).optional(),
    chopMin: z.number().min(0).max(100).optional(),
    atrPctMin: z.number().min(0).max(50).optional(),
    atrPctMax: z.number().min(0).max(100).optional(),
    allowLong: z.boolean().optional(),
    allowShort: z.boolean().optional(),
  })
  .optional();

const routerSchema = trendSchema.extend({
  useTrend: z.boolean().optional(),
  useMeanRev: z.boolean().optional(),
  meanRev: meanRevOverrideSchema,
});
const routerSchemaChecked = routerSchema.superRefine(crossFieldRefine);

/**
 * POST /api/backtest/router/local — backtest ROUTER (Trend + Mean-Reversion) trên dữ liệu 1m local.
 * Trend fire khi ADX cao; mean-rev fire khi range (ADX thấp & choppiness cao); gộp 1 portfolio.
 */
router.post(
  "/router/local",
  asyncHandler(async (req, res) => {
    const params = routerSchemaChecked.parse(req.body ?? {});
    const all = listLocal1mSymbols();
    const total =
      params.symbols && params.symbols.length
        ? params.symbols.filter((s) => all.includes(s.toUpperCase())).length
        : all.length;
    const job = createJob(total || all.length);

    runRouterLocal1mBacktest(params, (done, t, symbol) => {
      updateJob(job.id, { progress: done, total: t, currentSymbol: symbol });
    })
      .then((result) => {
        updateJob(job.id, { status: "done", result, finishedAt: Date.now() });
        logger.info("strategy", `Backtest ROUTER xong: ${result.totalTrades} lệnh (bỏ ${result.skippedByCap} do trần)`);
      })
      .catch((err) => {
        updateJob(job.id, { status: "error", error: String(err), finishedAt: Date.now() });
        logger.error("strategy", `Backtest ROUTER lỗi: ${String(err)}`);
      });

    res.json({ jobId: job.id, total });
  })
);

const gridSchema = trendSchema.extend({
  minTrades: z.number().int().min(0).max(10000).optional(),
  grid: z
    .object({
      dcEntry: z.array(z.number().int().min(10).max(400)).optional(),
      k1Atr: z.array(z.number().min(0.5).max(10)).optional(),
      k2Atr: z.array(z.number().min(0.5).max(15)).optional(),
      adxMin: z.array(z.number().min(0).max(60)).optional(),
      regimeEma: z.array(z.number().int().min(10).max(400)).optional(),
    })
    .optional(),
});
const gridSchemaChecked = gridSchema.superRefine(crossFieldRefine); // [M1]

/**
 * POST /api/backtest/trend/grid — grid search bộ tham số TREND, chạy nền.
 * Trả { jobId }; kết quả ở job.gridResult (best + ranked).
 */
router.post(
  "/trend/grid",
  asyncHandler(async (req, res) => {
    const params = gridSchemaChecked.parse(req.body ?? {});
    // Ước lượng số tổ hợp để set total cho job
    const g = params.grid ?? {};
    const nCombos =
      (g.dcEntry?.length ?? 3) * (g.k1Atr?.length ?? 3) * (g.k2Atr?.length ?? 3) * (g.adxMin?.length ?? 2) * (g.regimeEma?.length ?? 1);
    const job = createJob(nCombos);

    runTrendGrid(params, (done, total, label) => {
      updateJob(job.id, { progress: done, total, currentSymbol: label });
    })
      .then((gridResult) => {
        updateJob(job.id, {
          status: "done",
          gridResult,
          finishedAt: Date.now(),
          note: gridResult.best
            ? `Tốt nhất: DC${gridResult.best.dcEntry} k1=${gridResult.best.k1Atr} k2=${gridResult.best.k2Atr} ADX>${gridResult.best.adxMin} · Calmar ${gridResult.best.calmar}`
            : "Không có combo hợp lệ",
        });
        logger.info("strategy", `Grid TREND xong: ${gridResult.combos} tổ hợp`);
      })
      .catch((err) => {
        updateJob(job.id, { status: "error", error: String(err), finishedAt: Date.now() });
        logger.error("strategy", `Grid TREND lỗi: ${String(err)}`);
      });

    res.json({ jobId: job.id, total: nCombos });
  })
);

// ===================== MEAN REVERSION =====================

const meanRevSchema = z.object({
  symbols: z.array(z.string()).optional(),
  months: z.number().min(1).max(60).optional(),
  fromMs: z.number().int().positive().optional(),
  toMs: z.number().int().positive().optional(),
  initialCapitalUsdt: z.number().positive().optional(),
  leverage: z.number().min(1).max(125).optional(),
  marginMode: z.enum(["CROSS", "ISOLATED"]).optional(),
  compounding: z.boolean().optional(),
  feePct: z.number().min(0).max(5).optional(),
  slippagePct: z.number().min(0).max(5).optional(),
  useRealFunding: z.boolean().optional(),
  maxConcurrentPositions: z.number().int().min(0).max(500).optional(),
  riskPerTradePct: z.number().min(0).max(20).optional(),
  maxPortfolioRiskPct: z.number().min(0).max(100).optional(),
  // MR params
  n: z.number().int().min(10).max(500).optional(),
  zEntry: z.number().min(0.5).max(6).optional(),
  zPartial: z.number().min(0).max(6).optional(),
  zTp: z.number().min(-2).max(6).optional(),
  zStop: z.number().min(1).max(10).optional(),
  kSl: z.number().min(0.2).max(10).optional(),
  timeStopBars: z.number().int().min(2).max(2000).optional(),
  rsiPeriod: z.number().int().min(2).max(50).optional(),
  rsiLow: z.number().min(1).max(50).optional(),
  rsiHigh: z.number().min(50).max(99).optional(),
  adxMax: z.number().min(5).max(60).optional(),
  chopMin: z.number().min(0).max(100).optional(),
  atrPctMin: z.number().min(0).max(50).optional(),
  atrPctMax: z.number().min(0).max(100).optional(),
  volSpike: z.number().min(0).max(10).optional(),
  swingLookback: z.number().int().min(2).max(100).optional(),
  allowLong: z.boolean().optional(),
  allowShort: z.boolean().optional(),
  useRegimeExit: z.boolean().optional(),
  // Regime + universe + overlay (chung với TREND)
  useRegime: z.boolean().optional(),
  regimeMode: z.enum(["BTC1H_ALT1H", "BTC1H_ALT15M"]).optional(),
  regimeSymbol: z.string().optional(),
  regimeEmaPeriod: z.number().int().min(10).max(400).optional(),
  regimeSource: z.enum(["local", "binance"]).optional(),
  topLiquidity: z.number().int().min(0).max(600).optional(),
  ddReducePct: z.number().min(0).max(100).optional(),
  ddReduceFactor: z.number().min(0).max(1).optional(),
  ddHaltPct: z.number().min(0).max(100).optional(),
  ddResumePct: z.number().min(0).max(100).optional(),
  useCorrelationCap: z.boolean().optional(),
  maxPerCluster: z.number().int().min(0).max(100).optional(),
  corrThreshold: z.number().min(0).max(1).optional(),
});

// POST /api/backtest/meanrev/local — backtest MEAN REVERSION (job nền)
router.post(
  "/meanrev/local",
  asyncHandler(async (req, res) => {
    const params = meanRevSchema.parse(req.body ?? {});
    const all = listLocal1mSymbols();
    const total = params.symbols && params.symbols.length
      ? params.symbols.filter((s) => all.includes(s.toUpperCase())).length
      : all.length;
    const job = createJob(total || all.length);
    runMeanRevLocal1mBacktest(params, (done, t, symbol) => {
      updateJob(job.id, { progress: done, total: t, currentSymbol: symbol });
    })
      .then((result) => {
        updateJob(job.id, { status: "done", result, finishedAt: Date.now() });
        logger.info("strategy", `Backtest MEANREV xong: ${result.totalTrades} lệnh`);
      })
      .catch((err) => {
        updateJob(job.id, { status: "error", error: String(err), finishedAt: Date.now() });
        logger.error("strategy", `Backtest MEANREV lỗi: ${String(err)}`);
      });
    res.json({ jobId: job.id, total });
  })
);

const meanRevGridSchema = meanRevSchema.extend({
  minTrades: z.number().int().min(0).max(10000).optional(),
  grid: z.object({
    n: z.array(z.number().int().min(10).max(500)).optional(),
    zEntry: z.array(z.number().min(0.5).max(6)).optional(),
    zStop: z.array(z.number().min(1).max(10)).optional(),
    timeStopBars: z.array(z.number().int().min(2).max(2000)).optional(),
    adxMax: z.array(z.number().min(5).max(60)).optional(),
  }).optional(),
});

// POST /api/backtest/meanrev/grid — grid search MEAN REVERSION (job nền)
router.post(
  "/meanrev/grid",
  asyncHandler(async (req, res) => {
    const params = meanRevGridSchema.parse(req.body ?? {});
    const g = params.grid ?? {};
    const nCombos =
      (g.n?.length ?? 3) * (g.zEntry?.length ?? 3) * (g.zStop?.length ?? 2) * (g.timeStopBars?.length ?? 3) * (g.adxMax?.length ?? 1);
    const job = createJob(nCombos);
    runMeanRevGrid(params, (done, total, label) => {
      updateJob(job.id, { progress: done, total, currentSymbol: label });
    })
      .then((gridResult) => {
        updateJob(job.id, {
          status: "done",
          gridResult,
          finishedAt: Date.now(),
          note: gridResult.best ? `Tốt nhất: n${gridResult.best.n} z${gridResult.best.zEntry} · Calmar ${gridResult.best.calmar}` : "Không có combo hợp lệ",
        });
      })
      .catch((err) => {
        updateJob(job.id, { status: "error", error: String(err), finishedAt: Date.now() });
      });
    res.json({ jobId: job.id, total: nCombos });
  })
);

/**
 * POST /api/backtest/btc/fetch — kéo dữ liệu BTC (regime) từ Binance về cache đĩa.
 * body: { symbol?, interval?, fromMs?, toMs?, emaPeriod? }. Không có from/to -> phủ toàn bộ range local.
 */
const btcFetchSchema = z.object({
  symbol: z.string().optional(),
  interval: z.enum(["1h", "4h", "1d"]).optional(),
  fromMs: z.number().int().positive().optional(),
  toMs: z.number().int().positive().optional(),
  emaPeriod: z.number().int().min(10).max(400).optional(),
});

router.post(
  "/btc/fetch",
  asyncHandler(async (req, res) => {
    const body = btcFetchSchema.parse(req.body ?? {});
    const symbol = body.symbol ?? "BTCUSDT";
    const interval = body.interval ?? "1d";
    const emaPeriod = body.emaPeriod ?? 200;
    const step = interval === "1d" ? 86_400_000 : interval === "4h" ? 4 * 3_600_000 : 3_600_000;
    // Cửa sổ hiển thị = khoảng test alt (nếu truyền). Nếu không -> toàn bộ range local.
    let winFrom = body.fromMs;
    let winTo = body.toMs;
    if (!winFrom || !winTo) {
      const range = await getLocalDataRange();
      if (range) {
        winFrom = winFrom ?? range.minTs;
        winTo = winTo ?? range.maxTs;
      }
    }
    if (!winFrom || !winTo) return res.status(400).json({ message: "Thiếu fromMs/toMs và không có range local" });

    // Kéo kèm ĐỆM WARMUP trước winFrom để EMA đã "ấm" ngay đầu cửa sổ (regime chuẩn point-in-time).
    const klines = await getRegimeKlines(symbol, interval, winFrom - (emaPeriod + 5) * step, winTo);
    const series = buildRegimeSeries(klines, { symbol, interval, emaPeriod });
    // Chỉ đếm/hiển thị các nến TRONG cửa sổ test (khớp đúng khoảng backtest alt).
    let longBars = 0, shortBars = 0, offBars = 0, inWin = 0;
    let lastInWin: string = "OFF";
    let firstTs: number | null = null, lastTs: number | null = null;
    const monthMap = new Map<string, { long: number; short: number; off: number }>();
    for (let i = 0; i < series.times.length; i++) {
      const t = series.times[i];
      if (t < winFrom || t > winTo) continue;
      inWin++;
      if (firstTs === null) firstTs = t;
      lastTs = t;
      const side = series.side[i];
      lastInWin = side;
      if (side === "LONG") longBars++;
      else if (side === "SHORT") shortBars++;
      else offBars++;
      const d = new Date(t);
      const mk = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
      const m = monthMap.get(mk) ?? { long: 0, short: 0, off: 0 };
      if (side === "LONG") m.long++;
      else if (side === "SHORT") m.short++;
      else m.off++;
      monthMap.set(mk, m);
    }
    // Phân tích theo tháng: % thời gian LONG/SHORT/OFF (regime dẫn dắt lệnh alt).
    const byMonth = [...monthMap.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([month, c]) => {
        const total = c.long + c.short + c.off || 1;
        return {
          month,
          long: c.long,
          short: c.short,
          off: c.off,
          longPct: Math.round((c.long / total) * 100),
          shortPct: Math.round((c.short / total) * 100),
          offPct: Math.round((c.off / total) * 100),
        };
      });
    res.json({
      symbol,
      interval,
      emaPeriod,
      candles: inWin,
      from: firstTs ? new Date(firstTs).toISOString() : null,
      to: lastTs ? new Date(lastTs).toISOString() : null,
      currentRegime: lastInWin,
      longBars,
      shortBars,
      offBars,
      byMonth,
    });
  })
);

// ===================== TẢI DỮ LIỆU 1M TỪ BINANCE =====================

// GET /api/backtest/data/majors — rổ majors + coin nào đã có / còn thiếu trong /1m
router.get(
  "/data/majors",
  asyncHandler(async (_req, res) => {
    const items = MAJORS.map((symbol) => ({ symbol, present: localFileExists(symbol) }));
    res.json({ majors: items, missing: items.filter((i) => !i.present).map((i) => i.symbol) });
  })
);

const downloadSchema = z.object({
  symbols: z.array(z.string()).min(1).max(600),
  fromMs: z.number().int().positive().optional(),
  toMs: z.number().int().positive().optional(),
});

/**
 * POST /api/backtest/data/download — kéo full 1m history (Futures USDT-M) của danh sách symbol
 * về /1m (parquet), chạy nền. Trả { jobId }. Theo dõi qua GET /api/backtest/jobs/:id.
 */
router.post(
  "/data/download",
  asyncHandler(async (req, res) => {
    const body = downloadSchema.parse(req.body ?? {});
    const symbols = [...new Set(body.symbols.map((s) => s.trim().toUpperCase()).filter(Boolean))];
    const job = createJob(symbols.length);

    downloadMany(symbols, {
      fromMs: body.fromMs,
      toMs: body.toMs,
      onProgress: (done, total, current, pct) => {
        updateJob(job.id, {
          progress: done,
          total,
          currentSymbol: pct < 1 ? `${current} (${Math.round(pct * 100)}%)` : current,
        });
      },
    })
      .then((results) => {
        const ok = results.filter((r) => r.ok);
        const failed = results.filter((r) => !r.ok);
        const note = `Tải xong ${ok.length}/${results.length} symbol` + (failed.length ? ` · lỗi: ${failed.map((f) => f.symbol).join(", ")}` : "");
        updateJob(job.id, { status: "done", finishedAt: Date.now(), progress: symbols.length, note });
        logger.info("strategy", note);
      })
      .catch((err) => {
        updateJob(job.id, { status: "error", error: String(err), finishedAt: Date.now() });
        logger.error("strategy", `Tải dữ liệu lỗi: ${String(err)}`);
      });

    res.json({ jobId: job.id, total: symbols.length });
  })
);

// ===================== LỊCH SỬ BACKTEST =====================

const saveHistorySchema = z.object({
  // Bộ thông số đã dùng (để băm fingerprint + hiển thị lại)
  params: z.record(z.any()),
  interval: z.string().optional(),
  label: z.string().max(200).optional(),
  strategy: z.enum(["LONG", "EMA", "TREND", "MEANREV"]).optional(),
  // Toàn bộ BacktestResult (bắt buộc có from để suy ra năm)
  result: z.object({ from: z.string() }).passthrough(),
});

// POST /api/backtest/history — lưu (upsert) 1 lịch sử. Cùng (thông số + khung + năm) => ghi đè.
router.post(
  "/history",
  asyncHandler(async (req, res) => {
    const body = saveHistorySchema.parse(req.body ?? {});
    const saved = await saveBacktestHistory({
      params: body.params,
      interval: body.interval,
      result: body.result,
      label: body.label,
      strategy: body.strategy,
    });
    const strat = saved[0]?.strategy ?? body.strategy ?? "?";
    logger.info(
      "strategy",
      `Lưu lịch sử backtest [${strat}]: tách ${saved.length} tháng (${saved.map((s) => s.period).join(", ")})`
    );
    res.json({ count: saved.length, items: saved });
  })
);

// GET /api/backtest/history?year=&interval= — danh sách lịch sử (tóm tắt)
router.get(
  "/history",
  asyncHandler(async (req, res) => {
    const year = req.query.year ? Number(req.query.year) : undefined;
    const month = req.query.month ? Number(req.query.month) : undefined;
    const interval = (req.query.interval as string) || undefined;
    const strategy = (req.query.strategy as string) || undefined;
    res.json(await listBacktestHistory({ year, month, interval, strategy }));
  })
);

// DELETE /api/backtest/history?strategy=&year=&month= — xóa hàng loạt (bỏ trống = xóa TẤT CẢ)
router.delete(
  "/history",
  asyncHandler(async (req, res) => {
    const strategy = (req.query.strategy as string) || undefined;
    const year = req.query.year ? Number(req.query.year) : undefined;
    const month = req.query.month ? Number(req.query.month) : undefined;
    const count = await clearBacktestHistory({ strategy, year, month });
    logger.info("strategy", `Xóa ${count} lịch sử backtest (strategy=${strategy ?? "ALL"})`);
    res.json({ count });
  })
);

// GET /api/backtest/history/:id — 1 bản ghi đầy đủ (kèm result)
router.get(
  "/history/:id",
  asyncHandler(async (req, res) => {
    const item = await getBacktestHistory(Number(req.params.id));
    if (!item) return res.status(404).json({ error: "Not found" });
    res.json(item);
  })
);

// DELETE /api/backtest/history/:id — xóa 1 bản ghi
router.delete(
  "/history/:id",
  asyncHandler(async (req, res) => {
    await deleteBacktestHistory(Number(req.params.id));
    res.json({ ok: true });
  })
);

// GET /api/backtest/jobs/:id — trạng thái + kết quả job
router.get(
  "/jobs/:id",
  asyncHandler(async (req, res) => {
    const job = getJob(req.params.id);
    if (!job) return res.status(404).json({ error: "Job not found" });
    res.json(job);
  })
);

export default router;
