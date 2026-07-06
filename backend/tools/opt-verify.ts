/** Kiểm chứng winner trend & router trên nhiều cửa sổ. Chạy: npx tsx tools/opt-verify.ts */
import { runTrendLocal1mBacktest, runRouterLocal1mBacktest, type TrendBacktestParams, type RouterBacktestParams } from "../src/services/backtest.service";

const UNIVERSE = ["BTCUSDT", "ETHUSDT", "BNBUSDT", "SOLUSDT", "XRPUSDT", "DOGEUSDT", "TRXUSDT", "HYPEUSDT"];
const BASE: TrendBacktestParams = {
  regimeMode: "BTC1H_ALT15M", regimeSource: "local", symbols: UNIVERSE,
  allowLong: true, allowShort: true, initialCapitalUsdt: 10000, marginMode: "CROSS",
  riskCompound: true, compounding: false, leverage: 10, riskPerTradePct: 2, maxConcurrentPositions: 6,
  useRegime: true, useRegimeExit: true, useDonchianExit: true, useLiquidation: true,
  ddReducePct: 15, ddHaltPct: 30, ddResumePct: 15,
  dcEntry: 63, dcExit: 37, emaFast: 11, emaSlow: 34, emaTrend: 97, adxMin: 23, atrPeriod: 10,
  k1Atr: 3.36, k2Atr: 6.37, timeStopBars: 1200, atrPctMin: 0.42, atrPctMax: 4.5, cooldownBars: 3,
  regimeEmaPeriod: 100, useEntryScore: true, entryScoreMin: 77,
};
const MR = { n: 140, zEntry: 3.1, zStop: 3.7, kSl: 1.92, timeStopBars: 96, adxMax: 26, chopMin: 54, allowLong: true, allowShort: true };
const n = (x: number | null | undefined, d = 2) => (x == null || !Number.isFinite(x) ? "—" : x.toFixed(d));
const row = (tag: string, r: any) => console.log(`${tag.padEnd(16)} ROI ${n(r.roiPct, 1).padStart(7)}% · DD ${n(r.maxDrawdownPct, 1).padStart(5)}% · PF ${n(r.profitFactor).padStart(5)} · Sh ${n(r.sharpe).padStart(5)} · Exp ${n(r.expectancyR)}R · WR ${n(r.winRate, 0)}% · tr ${r.totalTrades}`);

(async () => {
  for (const m of [6, 12, 24]) {
    console.log(`\n=== ${m} tháng (long+short) ===`);
    row("TREND", await runTrendLocal1mBacktest({ ...BASE, months: m }));
    row("ROUTER (T+MR)", await runRouterLocal1mBacktest({ ...BASE, months: m, useTrend: true, useMeanRev: true, meanRev: MR } as RouterBacktestParams));
  }
  console.log("\nDONE");
})().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
