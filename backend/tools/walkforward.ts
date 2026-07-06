/**
 * Walk-Forward + Monte-Carlo validator (tái dùng).
 * Chạy: npx tsx tools/walkforward.ts [entryScoreMin] [isMonths] [oosMonths]
 *   vd: npx tsx tools/walkforward.ts 65 3 1
 *
 * - Walk-forward: áp CẤU HÌNH CỐ ĐỊNH lên các cửa sổ OOS lăn (train IS chỉ để mô phỏng "đã thấy"),
 *   đo tính nhất quán qua từng đoạn thời gian chưa-tối-ưu-trên-đó.
 * - Monte-Carlo: resample %pnl mỗi lệnh (có hoàn lại) + noise phí/slippage 1000×,
 *   ước lượng phân phối return, drawdown và Risk-of-Ruin.
 * Cấu hình mặc định = "Bot 15m + EntryScore" (4 coin mạnh). Sửa BOT bên dưới nếu cần.
 */
import { runTrendLocal1mBacktest, getLocalDataRange, type TrendBacktestParams } from "../src/services/backtest.service";

const argv = process.argv.slice(2);
const ENTRY_MIN = argv[0] ? Number(argv[0]) : 65;
const IS_M = argv[1] ? Number(argv[1]) : 3;   // train (in-sample) tháng
const OOS_M = argv[2] ? Number(argv[2]) : 1;  // test (out-of-sample) tháng
const DAY = 864e5, MONTH = 30 * DAY;

const BOT: TrendBacktestParams = {
  regimeMode: "BTC1H_ALT15M", regimeSource: "local",
  symbols: ["ETHUSDT", "XRPUSDT", "HYPEUSDT", "DOGEUSDT"],
  allowLong: true, allowShort: false, initialCapitalUsdt: 10000, marginMode: "CROSS",
  riskCompound: true, compounding: false, leverage: 10,
  dcEntry: 72, dcExit: 31, emaFast: 10, emaSlow: 48, emaTrend: 170, adxMin: 19, atrPeriod: 10,
  k1Atr: 3.43, k2Atr: 4.57, timeStopBars: 1820, atrPctMin: 0.53, atrPctMax: 8.1, cooldownBars: 6,
  useDonchianExit: true, useRegimeExit: true, regimeEmaPeriod: 50,
  riskPerTradePct: 2, maxConcurrentPositions: 6, ddReducePct: 15, ddHaltPct: 30, ddResumePct: 15,
  useEntryScore: ENTRY_MIN > 0, entryScoreMin: ENTRY_MIN,
};

const n = (x: number | null | undefined, d = 1) => x == null || !Number.isFinite(x) ? "—" : x.toFixed(d);

async function walkForward() {
  const range = (await getLocalDataRange())!;
  const folds: { from: number; to: number }[] = [];
  // OOS phủ ~12 tháng gần nhất
  let start = range.maxTs - (12 + IS_M) * MONTH;
  while (start + (IS_M + OOS_M) * MONTH <= range.maxTs) {
    const isTo = start + IS_M * MONTH;
    folds.push({ from: isTo, to: isTo + OOS_M * MONTH });
    start += OOS_M * MONTH;
  }
  console.log(`\n=== WALK-FORWARD (IS ${IS_M}m → OOS ${OOS_M}m, ${folds.length} fold, EntryScore≥${ENTRY_MIN}) ===`);
  let eq = 1; const rois: number[] = []; let maxDD = 0;
  for (let i = 0; i < folds.length; i++) {
    const r = await runTrendLocal1mBacktest({ ...BOT, fromMs: folds[i].from, toMs: folds[i].to });
    eq *= 1 + r.roiPct / 100; rois.push(r.roiPct); maxDD = Math.max(maxDD, r.maxDrawdownPct);
    console.log(`  Fold ${String(i + 1).padStart(2)} ${new Date(folds[i].from).toISOString().slice(0, 7)} | ROI ${n(r.roiPct).padStart(6)}% · DD ${n(r.maxDrawdownPct)}% · PF ${n(r.profitFactor, 2)} · tr ${r.totalTrades}`);
  }
  const pos = (100 * rois.filter((x) => x > 0).length / rois.length).toFixed(0);
  console.log(`  → OOS equity ×${eq.toFixed(2)} · % fold dương ${pos}% · avg/fold ${n(rois.reduce((a, b) => a + b, 0) / rois.length)}% · maxDD fold ${n(maxDD)}%`);
}

async function monteCarlo() {
  const r = await runTrendLocal1mBacktest({ ...BOT, months: 12 });
  const pnl = (r.trades ?? []).map((t: any) => t.pnlPct as number);
  console.log(`\n=== MONTE-CARLO (12m, ${pnl.length}/${r.totalTrades} lệnh mẫu, 1000 lần) ===`);
  if (pnl.length < 20) { console.log("  Không đủ lệnh."); return; }
  let s = 987654321; const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  const finals: number[] = [], dds: number[] = []; let ruin = 0;
  for (let it = 0; it < 1000; it++) {
    let cum = 0, peak = 0, mdd = 0, blown = false;
    for (let k = 0; k < pnl.length; k++) {
      const noise = 0.02 + rnd() * 0.08;
      cum += pnl[Math.floor(rnd() * pnl.length)] - noise;
      if (cum > peak) peak = cum;
      if (peak - cum > mdd) mdd = peak - cum;
      if (cum <= -80) blown = true; // proxy cháy: tổng %pnl (trước sizing) sụp sâu
    }
    finals.push(cum); dds.push(mdd); if (blown) ruin++;
  }
  finals.sort((a, b) => a - b); dds.sort((a, b) => a - b);
  const q = (a: number[], p: number) => a[Math.floor(p * a.length)];
  console.log(`  Return(Σ%): p5 ${n(q(finals, 0.05), 0)} · median ${n(q(finals, 0.5), 0)} · p95 ${n(q(finals, 0.95), 0)}`);
  console.log(`  Drawdown(Σ%): median ${n(q(dds, 0.5), 0)} · p95 ${n(q(dds, 0.95), 0)}`);
  console.log(`  % kịch bản dương: ${(100 * finals.filter((x) => x > 0).length / finals.length).toFixed(0)}% · Risk-of-Ruin proxy: ${(ruin / 10).toFixed(1)}%`);
  console.log(`  (Backtest 12m thực: ROI ${n(r.roiPct, 0)}% · DD ${n(r.maxDrawdownPct)}% · PF ${n(r.profitFactor, 2)} · Sharpe ${n(r.sharpe, 2)})`);
}

(async () => { await walkForward(); await monteCarlo(); console.log("\nDONE"); })()
  .then(() => process.exit(0))
  .catch((e) => { console.error(e); process.exit(1); });
