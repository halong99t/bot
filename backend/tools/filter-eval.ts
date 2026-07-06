/**
 * ĐÁNH GIÁ CẢI TIẾN LOGIC (KHÔNG tối ưu tham số) — so baseline vs từng bộ lọc trên CÙNG 12m/1H/8coin.
 * Chạy: npx tsx tools/filter-eval.ts
 * Chỉ thay ĐIỀU KIỆN VÀO LỆNH (confirm breakout, chiều). Mọi tham số EMA/ATR/ADX/SL/TP/risk GIỮ NGUYÊN.
 */
import { runTrendLocal1mBacktest, type TrendBacktestParams, type BacktestResult } from "../src/services/backtest.service";

const UNIVERSE = ["BTCUSDT", "ETHUSDT", "BNBUSDT", "SOLUSDT", "XRPUSDT", "DOGEUSDT", "TRXUSDT", "HYPEUSDT"];
const FIXED: TrendBacktestParams = {
  regimeMode: "BTC1H_ALT1H", regimeSource: "local", symbols: UNIVERSE,
  allowLong: true, allowShort: true, initialCapitalUsdt: 10000, marginMode: "CROSS",
  riskCompound: true, compounding: false, leverage: 5, useLiquidation: true,
  dcEntry: 43, dcExit: 25, emaFast: 13, emaSlow: 72, emaTrend: 162, adxMin: 19, atrPeriod: 16,
  k1Atr: 3.23, k2Atr: 4.3, timeStopBars: 514, atrPctMin: 0.33, atrPctMax: 7.1, cooldownBars: 14,
  useDonchianExit: false, useRegimeExit: true, regimeEmaPeriod: 50,
  useRegimeSlope: true, useRegimeBreadth: true, regimeBreadthMin: 0.51,
  riskPerTradePct: 0.52, maxConcurrentPositions: 12, ddHaltPct: 20,
  useCorrelationCap: true, maxPerCluster: 2, corrThreshold: 0.72,
  months: 12,
};

const n = (x: number | null | undefined, d = 2) => (x == null || !Number.isFinite(x) ? "—" : x.toFixed(d));
function metrics(r: BacktestResult) {
  const recovery = r.maxDrawdownPct > 0 ? r.roiPct / r.maxDrawdownPct : null;
  const perMonth = r.totalTrades / 12;
  return { roi: r.roiPct, pf: r.profitFactor, wr: r.winRate, expR: r.expectancyR, sharpe: r.sharpe, sortino: r.sortino, calmar: r.calmar, recovery, dd: r.maxDrawdownPct, hold: r.avgHoldingHours, trades: r.totalTrades, perMonth };
}
function row(tag: string, m: ReturnType<typeof metrics>) {
  console.log(
    `${tag.padEnd(30)} ROI ${n(m.roi, 1).padStart(7)}% · PF ${n(m.pf).padStart(5)} · WR ${n(m.wr, 1).padStart(5)}% · Exp ${n(m.expR).padStart(5)}R ` +
    `· Sh ${n(m.sharpe).padStart(5)} · So ${n(m.sortino).padStart(5)} · Cal ${n(m.calmar).padStart(5)} · Rec ${n(m.recovery).padStart(5)} ` +
    `· DD ${n(m.dd, 1).padStart(5)}% · hold ${n(m.hold, 0).padStart(3)}h · tr ${String(m.trades).padStart(3)} (${n(m.perMonth, 1)}/th)`
  );
}

const VARIANTS: { tag: string; p: Partial<TrendBacktestParams> }[] = [
  { tag: "0 BASELINE", p: {} },
  { tag: "1 confirm both ≥0.1ATR", p: { confirmBars: 1, confirmAtr: 0.1, confirmSide: "both" } },
  { tag: "2 confirm both ≥0.2ATR", p: { confirmBars: 1, confirmAtr: 0.2, confirmSide: "both" } },
  { tag: "3 confirm both ≥0.3ATR", p: { confirmBars: 1, confirmAtr: 0.3, confirmSide: "both" } },
  { tag: "4 confirm SHORT-only ≥0.2", p: { confirmBars: 1, confirmAtr: 0.2, confirmSide: "short" } },
  { tag: "5 confirm SHORT-only ≥0.3", p: { confirmBars: 1, confirmAtr: 0.3, confirmSide: "short" } },
  { tag: "6 long-only (ref)", p: { allowShort: false } },
  { tag: "7 long-only + confirm ≥0.2", p: { allowShort: false, confirmBars: 1, confirmAtr: 0.2, confirmSide: "both" } },
];

(async () => {
  console.log(`=== ĐÁNH GIÁ LOGIC · 12m · 1H · 8 coin · long+short · params CỐ ĐỊNH ===\n`);
  const results: { tag: string; m: ReturnType<typeof metrics> }[] = [];
  for (const v of VARIANTS) {
    const r = await runTrendLocal1mBacktest({ ...FIXED, ...v.p });
    const m = metrics(r); results.push({ tag: v.tag, m });
    row(v.tag, m);
  }
  const base = results[0].m;
  console.log(`\n=== Δ so với BASELINE (chỉ nhận nếu tốt hơn) ===`);
  for (const r of results.slice(1)) {
    const better = r.m.pf > base.pf && r.m.dd <= base.dd + 1 && r.m.trades >= 60;
    console.log(`  ${r.tag.padEnd(30)} ΔPF ${n(r.m.pf - base.pf).padStart(6)} · ΔExp ${n(r.m.expR - base.expR).padStart(6)}R · ΔDD ${n(r.m.dd - base.dd, 1).padStart(6)}pp · ΔROI ${n(r.m.roi - base.roi, 1).padStart(6)}pp · tr ${r.m.trades} ${better ? "✅ GIỮ" : "❌"}`);
  }
  console.log("\nDONE");
})().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
