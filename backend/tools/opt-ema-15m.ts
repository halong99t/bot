/**
 * Grid-search tối ưu tham số EMA classifier trên khung 15m, xếp hạng theo CALMAR (CAGR/MaxDD).
 *
 * Chạy:  node --import tsx tools/opt-ema-15m.ts [LIMIT]
 *   LIMIT (tùy chọn) = chạy tối đa N tổ hợp đầu (để đo thời gian). Bỏ trống = chạy hết.
 *
 * Khung sizing CỐ ĐỊNH để Calmar giữa các tổ hợp SO SÁNH ĐƯỢC:
 *   - risk 1%/lệnh (R-based), trần rủi ro danh mục 20% (=> ≤20 vị thế đồng thời), fixed-basis.
 *   - leverage 1, CROSS, phí/slippage mặc định thực tế (0.045/0.02).
 */
import { runEmaLocal1mBacktest, EmaBacktestParams, getLocalDataRange } from "../src/services/backtest.service";

const FIXED: EmaBacktestParams = {
  interval: "15m",
  initialCapitalUsdt: 1000,
  leverage: 1,
  marginMode: "CROSS",
  riskPerTradePct: 1,
  maxPortfolioRiskPct: 20,
  riskCompound: false,
  // feePct/slippagePct: để mặc định 0.045 / 0.02
};

// ----- Lưới tham số CHIẾN LƯỢC (giai đoạn coarse) -----
const EMA_PAIRS: [number, number][] = [[9, 21], [12, 26], [8, 34], [20, 50]];
const DIRECTIONS: ("LONG" | "SHORT" | "BOTH")[] = ["LONG", "SHORT", "BOTH"];
const EXITS: ("alignment" | "simple")[] = ["alignment", "simple"];

interface Combo {
  label: string;
  params: EmaBacktestParams;
}

function buildGrid(): Combo[] {
  const grid: Combo[] = [];
  for (const exitStrategy of EXITS) {
    for (const dir of DIRECTIONS) {
      for (const [fast, slow] of EMA_PAIRS) {
        const params: EmaBacktestParams = {
          ...FIXED,
          exitStrategy,
          direction: dir,
          fastPeriod: fast,
          slowPeriod: slow,
        };
        if (exitStrategy === "simple") {
          // TP/SL % giá cho nhánh simple
          params.tpSlMode = "PRICE";
          params.takeProfitPct = 6;
          params.stopLossPct = 3;
        } else {
          // alignment: neo SL protective, R theo cấu trúc
          params.slAnchor = "protective";
          params.slAtrMult = 1.5;
          params.emaBufferAtr = 0.25;
        }
        grid.push({ label: `${exitStrategy}|${dir}|${fast}/${slow}`, params });
      }
    }
  }
  return grid;
}

interface Row {
  label: string;
  calmar: number | null;
  roiPct: number;
  maxDrawdownPct: number;
  cagr: number;
  sharpe: number | null;
  sortino: number | null;
  totalTrades: number;
  winRate: number;
  profitFactor: number;
  blown: boolean;
}

const MIN_TRADES = 50; // dưới ngưỡng này Calmar không đáng tin

async function main() {
  const limit = process.argv[2] ? parseInt(process.argv[2], 10) : Infinity;
  const range = await getLocalDataRange();
  console.log("Local data range:", range ? `${new Date(range.minTs).toISOString()} .. ${new Date(range.maxTs).toISOString()}` : "N/A");

  const grid = buildGrid();
  const runList = grid.slice(0, limit);
  console.log(`Tổng tổ hợp: ${grid.length}, sẽ chạy: ${runList.length}\n`);

  const rows: Row[] = [];
  let idx = 0;
  for (const c of runList) {
    idx++;
    const t0 = Date.now();
    try {
      const r = await runEmaLocal1mBacktest(c.params);
      const dt = ((Date.now() - t0) / 1000).toFixed(1);
      rows.push({
        label: c.label,
        calmar: r.calmar,
        roiPct: r.roiPct,
        maxDrawdownPct: r.maxDrawdownPct,
        cagr: r.cagr,
        sharpe: r.sharpe,
        sortino: r.sortino,
        totalTrades: r.totalTrades,
        winRate: Number(r.winRate.toFixed(1)),
        profitFactor: r.profitFactor,
        blown: r.accountBlown,
      });
      console.log(
        `[${idx}/${runList.length}] ${c.label.padEnd(26)} ${dt}s  ` +
          `Calmar=${r.calmar}  ROI=${r.roiPct}%  MaxDD=${r.maxDrawdownPct}%  trades=${r.totalTrades}  win=${r.winRate.toFixed(1)}%`
      );
    } catch (err) {
      console.log(`[${idx}/${runList.length}] ${c.label} LỖI: ${String(err)}`);
    }
  }

  const fmt = (r: Row) =>
    `${r.label.padEnd(26)} ` +
    `${String(r.calmar).padStart(7)} ${String(r.roiPct).padStart(9)} ${String(r.maxDrawdownPct).padStart(7)} ` +
    `${String(r.cagr).padStart(8)} ${String(r.sharpe).padStart(7)} ${String(r.sortino).padStart(7)} ` +
    `${String(r.totalTrades).padStart(6)} ${String(r.winRate).padStart(5)} ${String(r.profitFactor).padStart(6)} ${r.blown ? "CHÁY" : ""}`;
  const HEAD = "label                       Calmar    ROI%     MaxDD%   CAGR%    Sharpe  Sortino  trades  win%    PF";

  // 1) Xếp hạng CALMAR trên các tổ hợp SỐNG SÓT (không cháy, đủ số lệnh, calmar hợp lệ).
  const survivors = rows.filter((r) => r.totalTrades >= MIN_TRADES && !r.blown && r.calmar !== null);
  survivors.sort((a, b) => (b.calmar ?? -Infinity) - (a.calmar ?? -Infinity));

  console.log(`\n===== XẾP HẠNG THEO CALMAR — tổ hợp SỐNG SÓT (≥${MIN_TRADES} lệnh, không cháy) =====`);
  console.log("rank  " + HEAD);
  if (!survivors.length) {
    console.log("  (KHÔNG có tổ hợp nào sống sót — mọi cấu hình đều cháy tài khoản trên toàn lịch sử 15m)");
  }
  survivors.slice(0, 15).forEach((r, i) => console.log(`${String(i + 1).padStart(3)}   ${fmt(r)}`));

  // 2) Xếp hạng EDGE (Profit Factor theo % giá — độc lập sizing) để biết có cấu hình nào lãi thật.
  const byEdge = [...rows].filter((r) => r.totalTrades >= MIN_TRADES).sort((a, b) => b.profitFactor - a.profitFactor);
  const positiveEdge = byEdge.filter((r) => r.profitFactor > 1);
  console.log(`\n===== XẾP HẠNG THEO EDGE (Profit Factor %, độc lập sizing) =====`);
  console.log("rank  " + HEAD);
  byEdge.slice(0, 15).forEach((r, i) => console.log(`${String(i + 1).padStart(3)}   ${fmt(r)}`));

  console.log(`\nSố cấu hình có edge dương (PF>1): ${positiveEdge.length}/${byEdge.length}`);

  const best = survivors[0] ?? positiveEdge[0];
  if (best) {
    const bestCombo = grid.find((g) => g.label === best.label)!;
    console.log(
      survivors[0]
        ? "\n>>> BỘ TỐI ƯU (Calmar cao nhất, sống sót):"
        : "\n>>> KHÔNG có tổ hợp sống sót. Cấu hình có EDGE tốt nhất (PF cao nhất):",
      best.label
    );
    console.log(JSON.stringify(bestCombo.params, null, 2));
  } else {
    console.log("\n>>> KẾT LUẬN: KHÔNG cấu hình nào có edge dương trên 15m với phí thực tế. Chiến lược EMA (lưới này) lỗ ròng.");
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
