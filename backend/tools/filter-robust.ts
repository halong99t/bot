/** Kiểm chứng bộ lọc R1 (confirm short ≥0.2ATR) trên nhiều cửa sổ. Chạy: npx tsx tools/filter-robust.ts */
import { runTrendLocal1mBacktest, type TrendBacktestParams } from "../src/services/backtest.service";
const U = ["BTCUSDT", "ETHUSDT", "BNBUSDT", "SOLUSDT", "XRPUSDT", "DOGEUSDT", "TRXUSDT", "HYPEUSDT"];
const F: TrendBacktestParams = {
  regimeMode: "BTC1H_ALT1H", regimeSource: "local", symbols: U,
  allowLong: true, allowShort: true, initialCapitalUsdt: 10000, marginMode: "CROSS",
  riskCompound: true, compounding: false, leverage: 5, useLiquidation: true,
  dcEntry: 43, dcExit: 25, emaFast: 13, emaSlow: 72, emaTrend: 162, adxMin: 19, atrPeriod: 16,
  k1Atr: 3.23, k2Atr: 4.3, timeStopBars: 514, atrPctMin: 0.33, atrPctMax: 7.1, cooldownBars: 14,
  useDonchianExit: false, useRegimeExit: true, regimeEmaPeriod: 50,
  useRegimeSlope: true, useRegimeBreadth: true, regimeBreadthMin: 0.51,
  riskPerTradePct: 0.52, maxConcurrentPositions: 12, ddHaltPct: 20,
  useCorrelationCap: true, maxPerCluster: 2, corrThreshold: 0.72,
};
const CONF = { confirmBars: 1, confirmAtr: 0.2, confirmSide: "short" as const };
const n = (x: number | null | undefined, d = 2) => (x == null || !Number.isFinite(x) ? "—" : x.toFixed(d));
const row = (t: string, r: any) => console.log(`${t.padEnd(22)} ROI ${n(r.roiPct, 1).padStart(7)}% · PF ${n(r.profitFactor).padStart(5)} · WR ${n(r.winRate, 0).padStart(3)}% · Exp ${n(r.expectancyR)}R · Sh ${n(r.sharpe)} · DD ${n(r.maxDrawdownPct, 1)}% · tr ${r.totalTrades}`);
(async () => {
  for (const m of [6, 12, 24]) {
    console.log(`\n=== ${m} tháng ===`);
    row("BASELINE", await runTrendLocal1mBacktest({ ...F, months: m }));
    row("+confirm SHORT 0.2", await runTrendLocal1mBacktest({ ...F, ...CONF, months: m }));
  }
  console.log("\nDONE");
})().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
