/**
 * Tối ưu tham số 15m cho rổ 8 coin — BẮT BUỘC LONG + SHORT.
 * Hai pha:
 *   (1) TREND: tìm bộ Donchian/EMA/ATR/regime tốt nhất (long+short).
 *   (2) ROUTER: giữ bộ trend tốt nhất, tối ưu overlay MEAN-REVERSION (long+short) → xem router có vượt trend không.
 *
 * Fitness (spec vận-hành-hằng-ngày, KHÔNG dùng total return):
 *   40% PF · 20% (1−DD/30) · 15% Expectancy · 10% Sharpe · 5% Sortino · 5% Freq · 5% Stability(1/(1+cv PF tuần))
 *   Gate cứng: cháy | <MIN_TRADES lệnh | PF<1 | phủ tuần <50%  → loại.
 *
 * Sizing CỐ ĐỊNH để so sánh edge: lev x10, risk 2%, maxConc 6, CROSS, phí thực tế, thanh lý bật.
 * Chạy: npx tsx tools/opt-15m-ls.ts [months] [trendRandom] [routerRandom]
 */
import {
  runTrendLocal1mBacktest,
  runRouterLocal1mBacktest,
  getLocalDataRange,
  type TrendBacktestParams,
  type RouterBacktestParams,
  type BacktestResult,
} from "../src/services/backtest.service";
import fs from "fs";

const MONTHS = process.argv[2] ? Number(process.argv[2]) : 6;
const TREND_RANDOM = process.argv[3] ? Number(process.argv[3]) : 70;
const ROUTER_RANDOM = process.argv[4] ? Number(process.argv[4]) : 50;
const UNIVERSE = ["BTCUSDT", "ETHUSDT", "BNBUSDT", "SOLUSDT", "XRPUSDT", "DOGEUSDT", "TRXUSDT", "HYPEUSDT"];
const MIN_TRADES = 40;
const WEEK_MS = 7 * 864e5;

// ---- PRNG tất định (Math.random có thể bị chặn) ----
let _s = 20260705;
const rnd = () => { _s = (_s * 1103515245 + 12345) & 0x7fffffff; return _s / 0x7fffffff; };
const pick = <T>(a: T[]): T => a[Math.floor(rnd() * a.length)];
const randint = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1));
const randf = (lo: number, hi: number, d = 2) => Number((lo + rnd() * (hi - lo)).toFixed(d));
const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));

// Sizing/khung cố định + BẮT BUỘC long+short.
const BASE: TrendBacktestParams = {
  regimeMode: "BTC1H_ALT15M", regimeSource: "local", symbols: UNIVERSE,
  allowLong: true, allowShort: true, // ← yêu cầu người dùng
  initialCapitalUsdt: 10000, marginMode: "CROSS", riskCompound: true, compounding: false,
  leverage: 10, riskPerTradePct: 2, maxConcurrentPositions: 6,
  useRegime: true, useRegimeExit: true, useDonchianExit: true, useLiquidation: true,
  ddReducePct: 15, ddHaltPct: 30, ddResumePct: 15,
};

interface TrendGene {
  dcEntry: number; dcExit: number; emaFast: number; emaSlow: number; emaTrend: number;
  adxMin: number; atrPeriod: number; k1Atr: number; k2Atr: number; timeStopBars: number;
  atrPctMin: number; atrPctMax: number; cooldownBars: number; regimeEmaPeriod: number;
  useEntryScore: boolean; entryScoreMin: number;
}
function randTrend(): TrendGene {
  const emaFast = randint(8, 15);
  const emaSlow = randint(emaFast + 15, 60);
  const emaTrend = randint(emaSlow + 40, 200);
  const dcEntry = randint(40, 120);
  const dcExit = randint(15, Math.min(50, dcEntry));
  const atrPctMin = randf(0.2, 0.7);
  const atrPctMax = randf(Math.max(4, atrPctMin + 3), 10, 1);
  const useES = rnd() < 0.6;
  return {
    dcEntry, dcExit, emaFast, emaSlow, emaTrend,
    adxMin: randint(12, 28), atrPeriod: pick([10, 14]),
    k1Atr: randf(2.0, 4.5), k2Atr: randf(3.5, 7.0),
    timeStopBars: pick([300, 500, 800, 1200, 1820, 2500]),
    atrPctMin, atrPctMax, cooldownBars: pick([0, 3, 6, 9, 12]),
    regimeEmaPeriod: pick([30, 50, 100, 170, 200]),
    useEntryScore: useES, entryScoreMin: useES ? randint(55, 78) : 0,
  };
}
function mutTrend(g: TrendGene): TrendGene {
  const n = { ...g };
  const j = (v: number, amt: number, lo: number, hi: number) => clamp(Math.round((v + (rnd() * 2 - 1) * amt) * 100) / 100, lo, hi);
  if (rnd() < 0.5) n.dcEntry = j(g.dcEntry, 20, 40, 120);
  if (rnd() < 0.5) n.dcExit = clamp(j(g.dcExit, 10, 15, 50), 15, n.dcEntry);
  if (rnd() < 0.4) n.adxMin = j(g.adxMin, 5, 12, 28);
  if (rnd() < 0.4) n.k1Atr = j(g.k1Atr, 0.8, 2.0, 4.5);
  if (rnd() < 0.4) n.k2Atr = j(g.k2Atr, 1.2, 3.5, 7.0);
  if (rnd() < 0.3) n.regimeEmaPeriod = pick([30, 50, 100, 170, 200]);
  if (rnd() < 0.3) n.cooldownBars = pick([0, 3, 6, 9, 12]);
  if (rnd() < 0.3) n.timeStopBars = pick([300, 500, 800, 1200, 1820, 2500]);
  if (rnd() < 0.3 && n.useEntryScore) n.entryScoreMin = j(g.entryScoreMin, 8, 55, 78);
  return n;
}
const toTrendParams = (g: TrendGene): TrendBacktestParams => ({ ...BASE, ...g, months: MONTHS });

interface MrGene {
  n: number; zEntry: number; zStop: number; kSl: number; timeStopBars: number;
  adxMax: number; chopMin: number; allowLong: boolean; allowShort: boolean;
}
function randMr(): MrGene {
  return {
    n: pick([60, 100, 140]), zEntry: randf(1.8, 3.2, 1), zStop: randf(3.0, 5.0, 1),
    kSl: randf(1.0, 2.5), timeStopBars: pick([24, 48, 96, 192]),
    adxMax: randint(14, 30), chopMin: randint(45, 62),
    allowLong: rnd() < 0.85, allowShort: rnd() < 0.85,
  };
}
function mutMr(g: MrGene): MrGene {
  const n = { ...g };
  const j = (v: number, amt: number, lo: number, hi: number, d = 1) => Number(clamp(v + (rnd() * 2 - 1) * amt, lo, hi).toFixed(d));
  if (rnd() < 0.5) n.zEntry = j(g.zEntry, 0.5, 1.8, 3.2);
  if (rnd() < 0.4) n.zStop = j(g.zStop, 0.6, 3.0, 5.0);
  if (rnd() < 0.4) n.adxMax = Math.round(j(g.adxMax, 4, 14, 30, 0));
  if (rnd() < 0.4) n.chopMin = Math.round(j(g.chopMin, 5, 45, 62, 0));
  if (rnd() < 0.3) n.kSl = j(g.kSl, 0.5, 1.0, 2.5, 2);
  if (rnd() < 0.3) n.timeStopBars = pick([24, 48, 96, 192]);
  if (rnd() < 0.2) n.allowShort = !g.allowShort;
  return n;
}

// ---------- Fitness ----------
function weeklyStability(r: BacktestResult): number {
  const byWeek = new Map<number, { gw: number; gl: number }>();
  for (const d of r.byDay) {
    const t = Date.parse(d.day + "T00:00:00Z");
    if (!Number.isFinite(t)) continue;
    const wk = Math.floor(t / WEEK_MS);
    const e = byWeek.get(wk) ?? { gw: 0, gl: 0 };
    e.gw += d.grossWin; e.gl += d.grossLoss;
    byWeek.set(wk, e);
  }
  const pfs = [...byWeek.values()].filter((e) => e.gw + e.gl > 0).map((e) => (e.gl > 0 ? Math.min(e.gw / e.gl, 5) : e.gw > 0 ? 5 : 0));
  if (pfs.length < 3) return 0.4;
  const mean = pfs.reduce((a, b) => a + b, 0) / pfs.length;
  if (mean <= 0) return 0;
  const std = Math.sqrt(pfs.reduce((a, b) => a + (b - mean) ** 2, 0) / pfs.length);
  return 1 / (1 + std / mean);
}
function weekCoverage(r: BacktestResult): { cov: number; perWeek: number } {
  const span = Math.max(1, (Date.parse(r.to) - Date.parse(r.from)) / WEEK_MS);
  const weeks = new Set<number>();
  for (const d of r.byDay) if (d.trades > 0) weeks.add(Math.floor(Date.parse(d.day + "T00:00:00Z") / WEEK_MS));
  return { cov: weeks.size / span, perWeek: r.totalTrades / span };
}
interface Scored { fitness: number; r: BacktestResult; stability: number; cov: number; perWeek: number; rejected?: string; }
function score(r: BacktestResult): Scored {
  const { cov, perWeek } = weekCoverage(r);
  const stability = weeklyStability(r);
  let rejected: string | undefined;
  if (r.accountBlown) rejected = "cháy";
  else if (r.totalTrades < MIN_TRADES) rejected = `ít lệnh(${r.totalTrades})`;
  else if (r.profitFactor < 1) rejected = `PF<1(${r.profitFactor})`;
  else if (cov < 0.5) rejected = `phủ tuần ${(cov * 100).toFixed(0)}%`;
  const pf = clamp(r.profitFactor, 0, 3) / 3;
  const dd = clamp(1 - r.maxDrawdownPct / 30, 0, 1);
  const exp = clamp((r.expectancyR + 0.2) / 0.7, 0, 1);
  const sh = clamp((r.sharpe ?? 0) / 3, 0, 1);
  const so = clamp((r.sortino ?? 0) / 4, 0, 1);
  const fr = clamp(perWeek / 10, 0, 1);
  const fitness = rejected ? -1 : 0.4 * pf + 0.2 * dd + 0.15 * exp + 0.1 * sh + 0.05 * so + 0.05 * fr + 0.05 * stability;
  return { fitness, r, stability, cov, perWeek, rejected };
}
const n2 = (x: number | null | undefined, d = 2) => (x == null || !Number.isFinite(x) ? "—" : x.toFixed(d));
function line(tag: string, s: Scored) {
  const r = s.r;
  return `${tag} fit ${n2(s.fitness, 3)} | ROI ${n2(r.roiPct, 1)}% DD ${n2(r.maxDrawdownPct, 1)}% PF ${n2(r.profitFactor)} ` +
    `Sh ${n2(r.sharpe)} Exp ${n2(r.expectancyR)}R WR ${n2(r.winRate, 0)}% tr ${r.totalTrades} /w ${n2(s.perWeek, 1)} stab ${n2(s.stability, 2)}${s.rejected ? " ✗" + s.rejected : ""}`;
}

async function main() {
  const range = await getLocalDataRange();
  console.log(`Data tới ${range ? new Date(range.maxTs).toISOString().slice(0, 10) : "?"} · cửa sổ ${MONTHS}m · rổ ${UNIVERSE.length} coin · LONG+SHORT`);

  // ===== PHA 1: TREND =====
  console.log(`\n===== PHA 1 · TREND (random ${TREND_RANDOM} + GA) =====`);
  let pool: { g: TrendGene; s: Scored }[] = [];
  let i = 0;
  for (; i < TREND_RANDOM; i++) {
    const g = randTrend();
    try {
      const s = score(await runTrendLocal1mBacktest(toTrendParams(g)));
      pool.push({ g, s });
      if (i % 5 === 0 || !s.rejected) console.log(line(`[${i + 1}/${TREND_RANDOM}]`, s));
    } catch (e) { console.log(`[${i + 1}] lỗi ${String(e).slice(0, 80)}`); }
  }
  // GA: 2 thế hệ, elit 8 + đột biến
  for (let gen = 0; gen < 2; gen++) {
    pool.sort((a, b) => b.s.fitness - a.s.fitness);
    const elite = pool.slice(0, 8);
    console.log(`\n-- GA gen ${gen + 1}: elite tốt nhất ${n2(elite[0]?.s.fitness, 3)} --`);
    const kids: TrendGene[] = [];
    for (let k = 0; k < 16; k++) kids.push(mutTrend(pick(elite).g));
    for (const g of kids) {
      try { pool.push({ g, s: score(await runTrendLocal1mBacktest(toTrendParams(g))) }); } catch { /* skip */ }
    }
  }
  pool.sort((a, b) => b.s.fitness - a.s.fitness);
  const bestTrend = pool[0];
  console.log(`\n>>> TOP 5 TREND (long+short):`);
  pool.slice(0, 5).forEach((p, k) => console.log(line(`  #${k + 1}`, p.s)));
  console.log(`\nBEST TREND params:`, JSON.stringify(bestTrend.g));

  // ===== PHA 2: ROUTER (giữ trend, tối ưu overlay mean-rev) =====
  console.log(`\n===== PHA 2 · ROUTER = best-trend + MEAN-REV overlay (random ${ROUTER_RANDOM} + GA) =====`);
  const routerBase: RouterBacktestParams = { ...toTrendParams(bestTrend.g), useTrend: true, useMeanRev: true };
  let rpool: { g: MrGene; s: Scored }[] = [];
  for (let j = 0; j < ROUTER_RANDOM; j++) {
    const g = randMr();
    try {
      const s = score(await runRouterLocal1mBacktest({ ...routerBase, meanRev: g }));
      rpool.push({ g, s });
      if (j % 5 === 0 || !s.rejected) console.log(line(`[${j + 1}/${ROUTER_RANDOM}]`, s));
    } catch (e) { console.log(`[${j + 1}] lỗi ${String(e).slice(0, 80)}`); }
  }
  for (let gen = 0; gen < 1; gen++) {
    rpool.sort((a, b) => b.s.fitness - a.s.fitness);
    const elite = rpool.slice(0, 6);
    const kids: MrGene[] = [];
    for (let k = 0; k < 12; k++) kids.push(mutMr(pick(elite).g));
    for (const g of kids) {
      try { rpool.push({ g, s: score(await runRouterLocal1mBacktest({ ...routerBase, meanRev: g })) }); } catch { /* skip */ }
    }
  }
  rpool.sort((a, b) => b.s.fitness - a.s.fitness);
  const bestRouter = rpool[0];
  console.log(`\n>>> TOP 5 ROUTER (best-trend + MR, long+short):`);
  rpool.slice(0, 5).forEach((p, k) => console.log(line(`  #${k + 1}`, p.s)));

  // ===== So sánh =====
  console.log(`\n===== KẾT LUẬN =====`);
  console.log(line("TREND best :", bestTrend.s));
  console.log(line("ROUTER best:", bestRouter.s));
  const dF = bestRouter.s.fitness - bestTrend.s.fitness;
  console.log(`Router ${dF > 0.005 ? "VƯỢT" : dF < -0.005 ? "THUA" : "HÒA"} trend (Δfitness ${n2(dF, 3)}, ΔPF ${n2(bestRouter.s.r.profitFactor - bestTrend.s.r.profitFactor)}, ΔDD ${n2(bestRouter.s.r.maxDrawdownPct - bestTrend.s.r.maxDrawdownPct, 1)}pp)`);

  const out = {
    months: MONTHS, universe: UNIVERSE, longShort: true,
    bestTrend: { params: bestTrend.g, metrics: pick1(bestTrend.s) },
    bestRouter: { trend: bestTrend.g, meanRev: bestRouter.g, metrics: pick1(bestRouter.s) },
    topTrend: pool.slice(0, 5).map((p) => ({ params: p.g, metrics: pick1(p.s) })),
    topRouter: rpool.slice(0, 5).map((p) => ({ meanRev: p.g, metrics: pick1(p.s) })),
  };
  fs.writeFileSync("_opt15mls_result.json", JSON.stringify(out, null, 2));
  console.log(`\nĐã ghi backend/_opt15mls_result.json`);
}
function pick1(s: Scored) {
  const r = s.r;
  return { fitness: Number(s.fitness.toFixed(3)), roiPct: r.roiPct, maxDrawdownPct: r.maxDrawdownPct, profitFactor: r.profitFactor, sharpe: r.sharpe, sortino: r.sortino, expectancyR: r.expectancyR, winRate: r.winRate, totalTrades: r.totalTrades, perWeek: Number(s.perWeek.toFixed(2)), stability: Number(s.stability.toFixed(2)), coverage: Number(s.cov.toFixed(2)) };
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
