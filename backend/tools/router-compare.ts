/**
 * So sánh ROUTER (Trend + MeanRev) vs TREND-only vs MEANREV-only.
 * Chạy: npx tsx tools/router-compare.ts [months]
 * Dùng cấu hình BOT 15m + EntryScore trên rổ 8 coin cố định.
 */
import {
  runTrendLocal1mBacktest,
  runRouterLocal1mBacktest,
  type TrendBacktestParams,
  type RouterBacktestParams,
} from "../src/services/backtest.service";

const MONTHS = process.argv[2] ? Number(process.argv[2]) : 6;
const UNIVERSE = ["BTCUSDT", "ETHUSDT", "BNBUSDT", "SOLUSDT", "XRPUSDT", "DOGEUSDT", "TRXUSDT", "HYPEUSDT"];

// Cấu hình trend "Bot 15m + EntryScore≥65" (winner đã qua walk-forward).
const TREND: TrendBacktestParams = {
  regimeMode: "BTC1H_ALT15M", regimeSource: "local", symbols: UNIVERSE,
  allowLong: true, allowShort: false, initialCapitalUsdt: 10000, marginMode: "CROSS",
  riskCompound: true, compounding: false, leverage: 10,
  dcEntry: 72, dcExit: 31, emaFast: 10, emaSlow: 48, emaTrend: 170, adxMin: 19, atrPeriod: 10,
  k1Atr: 3.43, k2Atr: 4.57, timeStopBars: 1820, atrPctMin: 0.53, atrPctMax: 8.1, cooldownBars: 6,
  useDonchianExit: true, useRegimeExit: true, regimeEmaPeriod: 50,
  riskPerTradePct: 2, maxConcurrentPositions: 6, ddReducePct: 15, ddHaltPct: 30, ddResumePct: 15,
  useEntryScore: true, entryScoreMin: 65, useLiquidation: true,
};

const n = (x: number | null | undefined, d = 2) =>
  x == null || !Number.isFinite(x) ? "—" : x.toFixed(d);

function row(label: string, r: any) {
  console.log(
    `${label.padEnd(22)} ROI ${n(r.roiPct, 1).padStart(7)}% · DD ${n(r.maxDrawdownPct, 1).padStart(5)}% ` +
    `· PF ${n(r.profitFactor).padStart(5)} · Sharpe ${n(r.sharpe).padStart(5)} · WR ${n(r.winRate, 0).padStart(3)}% ` +
    `· lệnh ${String(r.totalTrades).padStart(4)} · Exp ${n(r.expectancyR)}R · Calmar ${n(r.calmar)}`
  );
}

(async () => {
  console.log(`\n=== ROUTER COMPARE (${MONTHS}m, rổ 8 coin, lev x10) ===\n`);

  const trend = await runTrendLocal1mBacktest({ ...TREND, months: MONTHS });
  row("TREND-only", trend);

  const meanrevParams: RouterBacktestParams = { ...TREND, months: MONTHS, useTrend: false, useMeanRev: true };
  const meanrev = await runRouterLocal1mBacktest(meanrevParams);
  row("MEANREV-only", meanrev);

  const routerParams: RouterBacktestParams = { ...TREND, months: MONTHS, useTrend: true, useMeanRev: true };
  const router = await runRouterLocal1mBacktest(routerParams);
  row("ROUTER (T+MR)", router);

  // MR tuned: chỉ fade cú lệch MẠNH (zEntry cao) + stop chặt + range chặt hơn (ADX≤22, CI≥55).
  const tunedVariants = [
    { label: "ROUTER MR z2.5/adx22", meanRev: { zEntry: 2.5, zStop: 3.2, adxMax: 22, chopMin: 55, allowShort: false } },
    { label: "ROUTER MR z3/adx18", meanRev: { zEntry: 3.0, zStop: 3.8, adxMax: 18, chopMin: 60, allowShort: false } },
  ];
  for (const v of tunedVariants) {
    const r = await runRouterLocal1mBacktest({ ...TREND, months: MONTHS, useTrend: true, useMeanRev: true, meanRev: v.meanRev });
    row(v.label, r);
  }

  console.log(`\n→ So với trend-only: ΔPF ${n(router.profitFactor - trend.profitFactor)} · ` +
    `ΔDD ${n(router.maxDrawdownPct - trend.maxDrawdownPct, 1)}pp · ` +
    `ΔROI ${n(router.roiPct - trend.roiPct, 1)}pp · ` +
    `Δlệnh ${router.totalTrades - trend.totalTrades}`);
  console.log("\nDONE");
})().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
