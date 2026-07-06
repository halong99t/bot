/**
 * Script kiểm tra nhanh chiến lược TREND FOLLOWING trên dữ liệu 1m local.
 * Chạy: npx tsx scripts/verify-trend.ts
 */
import { runTrendLocal1mBacktest } from "../src/services/backtest.service";
import { listLocal1mSymbols } from "../src/services/backtest.service";

async function main() {
  const all = new Set(listLocal1mSymbols());
  // Rổ alt thanh khoản cao (đại diện, không phải memecoin nhiễu) — giao với data có sẵn.
  const curated = [
    "SOLUSDT", "AVAXUSDT", "LINKUSDT", "DOTUSDT", "ADAUSDT", "NEARUSDT", "ATOMUSDT",
    "LTCUSDT", "AAVEUSDT", "UNIUSDT", "XRPUSDT", "DOGEUSDT", "TRXUSDT", "ETCUSDT",
    "FILUSDT", "APTUSDT", "ARBUSDT", "OPUSDT", "INJUSDT", "SUIUSDT",
  ];
  const sample = curated.filter((s) => all.has(s));
  console.log(`Universe local: ${all.size} coin. Test ${sample.length} alt thanh khoản: ${sample.join(", ")}`);

  const t0 = Date.now();
  const r = await runTrendLocal1mBacktest({
    symbols: sample,
    interval: "1h",
    riskPerTradePct: 0.5,
    maxConcurrentPositions: 15,
    maxPortfolioRiskPct: 8,
    initialCapitalUsdt: 10000,
    leverage: 5,
    compounding: false,
    useRegime: true,
    regimeInterval: "1d",
    regimeEmaPeriod: 200,
    allowLong: true,
    allowShort: false,
    // Cùng tham số chiến lược với B — chỉ KHÁC ở risk management (A tắt hết)
    dcEntry: 150,
    dcExit: 250,
    k1Atr: 3,
    k2Atr: 6,
    timeStopBars: 2000,
    adxMin: 20,
  });

  await report("A) RISK-OFF (thả lời chạy, KHÔNG breaker/corr-cap)", r, ((Date.now() - t0) / 1000).toFixed(1));

  // ---- Cấu hình B: BẬT risk management (DD circuit breaker + correlation cluster cap) ----
  const t1 = Date.now();
  const rGuard = await runTrendLocal1mBacktest({
    symbols: sample,
    interval: "1h",
    riskPerTradePct: 0.5,
    maxConcurrentPositions: 15,
    maxPortfolioRiskPct: 8,
    initialCapitalUsdt: 10000,
    leverage: 5,
    compounding: false,
    useRegime: true,
    regimeInterval: "1d",
    regimeEmaPeriod: 200,
    allowLong: true,
    allowShort: false,
    dcEntry: 150,
    dcExit: 250,
    k1Atr: 3,
    k2Atr: 6,
    timeStopBars: 2000,
    adxMin: 20,
    // Risk management BẬT:
    ddReducePct: 15,
    ddReduceFactor: 0.5,
    ddHaltPct: 20,
    ddResumePct: 10,
    useCorrelationCap: true,
    maxPerCluster: 2,
    corrThreshold: 0.8,
  });
  await report("B) RISK-ON (DD breaker 15/20→10 + corr-cap 2/cụm@0.8)", rGuard, ((Date.now() - t1) / 1000).toFixed(1));

  console.log("\n===== SO SÁNH =====");
  console.log(`MaxDD:  A ${r.maxDrawdownPct}%  →  B ${rGuard.maxDrawdownPct}%`);
  console.log(`ROI:    A ${r.roiPct}%  →  B ${rGuard.roiPct}%`);
  console.log(`Calmar: A ${r.calmar}  →  B ${rGuard.calmar}`);
  console.log(`Lệnh:   A ${r.totalTrades}  →  B ${rGuard.totalTrades} (bỏ bởi breaker: ${(rGuard as any).skippedByRisk})`);
}

async function report(title: string, r: Awaited<ReturnType<typeof runTrendLocal1mBacktest>>, took: string) {
  console.log(`\n===== ${title}  (chạy ${took}s) =====`);
  console.log(`Khoảng:            ${r.from} -> ${r.to}`);
  console.log(`Symbol test:       ${r.symbolsTested.length}`);
  console.log(`Tổng tín hiệu:     ${r.candidateTrades} (bỏ ${r.skippedByCap} do trần, peak ${r.peakConcurrent})`);
  console.log(`Tổng lệnh:         ${r.totalTrades}`);
  console.log(`Win rate:          ${r.winRate.toFixed(1)}%`);
  console.log(`Profit Factor:     ${r.profitFactor}  (USDT: ${r.profitFactorUsdt})`);
  console.log(`Expectancy(R):     ${r.expectancyR}`);
  console.log(`Avg holding:       ${r.avgHoldingHours}h`);
  console.log(`--- Tiền (vốn ${r.initialCapitalUsdt} USDT, lev ${r.leverage}x) ---`);
  console.log(`Final balance:     ${r.finalBalanceUsdt} USDT  (ROI ${r.roiPct}%)`);
  console.log(`CAGR:              ${r.cagr}%`);
  console.log(`Max Drawdown:      ${r.maxDrawdownPct}%  (${r.maxDrawdownUsdt} USDT)`);
  console.log(`Sharpe:            ${r.sharpe}`);
  console.log(`Sortino:           ${r.sortino}`);
  console.log(`Calmar:            ${r.calmar}`);
  console.log(`Account blown:     ${r.accountBlown}`);
  console.log(`--- Theo kiểu thoát ---`);
  for (const g of r.byReason) {
    console.log(`  ${g.key.padEnd(6)} ${String(g.trades).padStart(4)} lệnh  win ${g.winRate}%  ret ${g.returnPct}%`);
  }
  console.log(`\nTop symbol theo số lệnh:`);
  for (const s of [...r.perSymbol].sort((a, b) => b.trades - a.trades).slice(0, 8)) {
    console.log(`  ${s.symbol.padEnd(12)} ${String(s.trades).padStart(4)} lệnh  ${s.wins} win  ret ${s.returnPct.toFixed(1)}%`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("LỖI:", e);
    process.exit(1);
  });
