import { useState, useEffect, type ReactNode } from "react";
import { toast } from "sonner";
import { api } from "../api/client";
import Tooltip from "../components/Tooltip";
import BacktestResults from "../components/BacktestResults";
import TimeRangePicker from "../components/TimeRangePicker";
import SavedBacktestHistory from "../components/SavedBacktestHistory";
import type { BacktestResult, BacktestHistoryItem, MeanRevGridResult, MeanRevGridRow } from "../types";

type RegimeMode = "BTC1H_ALT1H";
const REGIME_MODES: { mode: RegimeMode; label: string; altIv: string; regimeIv: string }[] = [
  { mode: "BTC1H_ALT1H", label: "BTC 1h → alt 1h", altIv: "1h", regimeIv: "1h" },
];
const MAJORS = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT", "DOGEUSDT", "ADAUSDT", "AVAXUSDT", "LINKUSDT", "DOTUSDT"];

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="space-y-1">
      <label className="text-xs text-gray-400 uppercase flex items-center">
        {label}
        {hint ? <Tooltip text={hint}><span className="ml-1 text-gray-500 cursor-help">ⓘ</span></Tooltip> : null}
      </label>
      {children}
    </div>
  );
}

interface MrForm {
  n: number; zEntry: number; zPartial: number; zTp: number; zStop: number; kSl: number;
  timeStopBars: number; rsiLow: number; rsiHigh: number; adxMax: number; chopMin: number;
  atrPctMin: number; atrPctMax: number; volSpike: number;
}

export default function MeanReversion() {
  const [regimeMode, setRegimeMode] = useState<RegimeMode>("BTC1H_ALT1H");
  const modeInfo = REGIME_MODES.find((m) => m.mode === regimeMode)!;
  const [mr, setMr] = useState<MrForm>({
    n: 100, zEntry: 2.0, zPartial: 1.5, zTp: -1.0, zStop: 3.8, kSl: 1.5,
    timeStopBars: 48, rsiLow: 30, rsiHigh: 70, adxMax: 30, chopMin: 50,
    atrPctMin: 0.4, atrPctMax: 6, volSpike: 0,
  });
  const setM = (k: keyof MrForm, v: string) => setMr((f) => ({ ...f, [k]: Number(v) }));

  const [allowLong, setAllowLong] = useState(true);
  const [allowShort, setAllowShort] = useState(true);
  const [useRegime, setUseRegime] = useState(true);
  const [regimeEmaPeriod, setRegimeEmaPeriod] = useState(200);

  const [initialCapitalUsdt] = useState(10000);
  const [riskPerTradePct, setRisk] = useState(0.5);
  const [maxConcurrentPositions, setMaxConc] = useState(15);
  const [leverage, setLeverage] = useState(5);
  const [feePct, setFeePct] = useState(0.045);
  const [slippagePct, setSlippagePct] = useState(0.02);
  const [topLiquidity, setTopLiquidity] = useState(40);
  // Risk overlay
  const [useDdBreaker, setUseDdBreaker] = useState(true);
  const [ddHaltPct, setDdHaltPct] = useState(20);

  const [localCount, setLocalCount] = useState<number | null>(null);
  const [localSymbols, setLocalSymbols] = useState("");
  const [rangeMode, setRangeMode] = useState<"recent" | "year" | "custom">("recent");
  const [months, setMonths] = useState(6);
  const [year, setYear] = useState(2025);
  const [monthsSel, setMonthsSel] = useState<number[]>([]);
  const [yearsSel, setYearsSel] = useState<number[]>([2024]);
  const [dataRange, setDataRange] = useState<{ minTs: number; maxTs: number } | null>(null);

  const [result, setResult] = useState<BacktestResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number; symbol?: string } | null>(null);
  const [runParams, setRunParams] = useState<Record<string, unknown> | null>(null);
  const [saving, setSaving] = useState(false);
  const [historyKey, setHistoryKey] = useState(0);

  const [grid, setGrid] = useState<MeanRevGridResult | null>(null);
  const [gridProgress, setGridProgress] = useState<{ done: number; total: number; label?: string } | null>(null);
  const [gridLoading, setGridLoading] = useState(false);

  useEffect(() => {
    api.getLocalSymbols().then((d) => setLocalCount(d.count)).catch(() => setLocalCount(0));
    api.getLocalRange().then((r) => {
      if (r.maxTs > 0) { setDataRange(r); const d = new Date(r.maxTs); setYear(d.getUTCFullYear()); setYearsSel([d.getUTCFullYear()]); }
    }).catch(() => {});
  }, []);

  const currentRange = (): { fromMs?: number; toMs?: number } => {
    if (rangeMode === "custom" && monthsSel.length) {
      const s = [...monthsSel].sort((a, b) => a - b);
      return { fromMs: new Date(year, s[0] - 1, 1).getTime(), toMs: new Date(year, s[s.length - 1], 1).getTime() };
    }
    if (rangeMode === "year" && yearsSel.length) {
      const ys = [...yearsSel].sort((a, b) => a - b);
      return { fromMs: new Date(ys[0], 0, 1).getTime(), toMs: new Date(ys[ys.length - 1] + 1, 0, 1).getTime() };
    }
    const toMs = Date.now();
    return { fromMs: toMs - months * 30 * 86400000, toMs };
  };

  const baseBody = () => {
    const symbols = localSymbols.split(/[\s,]+/).map((s) => s.trim().toUpperCase()).filter(Boolean);
    const { fromMs, toMs } = currentRange();
    return {
      regimeMode, ...mr, allowLong, allowShort, useRegime, regimeEmaPeriod,
      riskPerTradePct, maxConcurrentPositions, initialCapitalUsdt, leverage, compounding: false,
      feePct, slippagePct, topLiquidity,
      ddHaltPct: useDdBreaker ? ddHaltPct : 0, ddResumePct: useDdBreaker ? Math.round(ddHaltPct / 2) : 0,
      ddReducePct: useDdBreaker ? Math.max(8, ddHaltPct - 5) : 0, ddReduceFactor: 0.5,
      fromMs, toMs, symbols: symbols.length ? symbols : undefined,
    } as Record<string, unknown>;
  };

  const runBacktest = async () => {
    if (!allowLong && !allowShort) return toast.error("Bật ít nhất 1 hướng");
    setLoading(true); setResult(null); setProgress({ done: 0, total: 0 });
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const body = baseBody();
    try {
      const { jobId, total } = await api.runMeanRevBacktest(body);
      setProgress({ done: 0, total });
      for (let i = 0; i < 8000; i++) {
        const job = await api.getBacktestJob(jobId);
        setProgress({ done: job.progress, total: job.total, symbol: job.currentSymbol });
        if (job.status === "done" && job.result) { setResult(job.result); setRunParams(body); toast.success(`${job.result.totalTrades} lệnh · ROI ${job.result.roiPct}%`); break; }
        if (job.status === "error") { toast.error(job.error ?? "lỗi"); break; }
        await sleep(700);
      }
    } catch (e: any) { toast.error(e?.response?.data?.message ?? "Backtest MR thất bại"); }
    finally { setLoading(false); setProgress(null); }
  };

  const runGrid = async () => {
    setGridLoading(true); setGrid(null); setGridProgress({ done: 0, total: 0 });
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    try {
      const { jobId, total } = await api.runMeanRevGrid({ ...baseBody(), ddHaltPct: 0, ddReducePct: 0, useCorrelationCap: false });
      setGridProgress({ done: 0, total });
      for (let i = 0; i < 20000; i++) {
        const job = await api.getBacktestJob(jobId);
        setGridProgress({ done: job.progress, total: job.total, label: job.currentSymbol });
        if (job.status === "done" && job.gridResult) {
          setGrid(job.gridResult as MeanRevGridResult);
          const b = (job.gridResult as MeanRevGridResult).best;
          toast.success(b ? `Tốt nhất: n${b.n} z${b.zEntry} zStop${b.zStop} TS${b.timeStopBars} · Calmar ${b.calmar}` : "Không có combo hợp lệ");
          break;
        }
        if (job.status === "error") { toast.error(job.error ?? "Grid lỗi"); break; }
        await sleep(1000);
      }
    } catch (e: any) { toast.error(e?.response?.data?.message ?? "Grid thất bại"); }
    finally { setGridLoading(false); setGridProgress(null); }
  };

  const applyGridRow = (r: MeanRevGridRow) => {
    setMr((f) => ({ ...f, n: r.n, zEntry: r.zEntry, zStop: r.zStop, timeStopBars: r.timeStopBars, adxMax: r.adxMax }));
    toast.success(`Đã nạp n${r.n} z${r.zEntry} zStop${r.zStop} TS${r.timeStopBars} ADX≤${r.adxMax}`);
  };

  const saveResult = async () => {
    if (!result || !runParams) return;
    setSaving(true);
    try {
      const { count } = await api.saveBacktestHistory({ params: runParams, interval: modeInfo.altIv, strategy: "MEANREV", result });
      toast.success(`Đã lưu lịch sử MEANREV — tách ${count} tháng`); setHistoryKey((k) => k + 1);
    } catch (e: any) { toast.error(e?.response?.data?.message ?? "Lưu thất bại"); }
    finally { setSaving(false); }
  };

  const openRecord = async (item: BacktestHistoryItem) => {
    try { const full = await api.getBacktestHistory(item.id); if (full.result) { setResult(full.result); setRunParams(full.params as any); toast.success(`Đã mở [${item.interval}] ${item.year}`); } }
    catch { toast.error("Không mở được"); }
  };

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-xl font-bold">Mean Reversion (fade z-score trong regime range)</h2>
        <p className="text-xs text-gray-400 mt-1 max-w-3xl">
          Vào ngược cú lệch |z| ≥ ngưỡng khi thị trường KHÔNG trend (ADX thấp + Choppiness cao, đo ở bar trước cú lệch),
          RSI cực trị, giá ngoài Bollinger; thoát khi giá hồi về fair value (scale-out) + z-stop + time-stop. Cổng regime BTC
          chặn fade ngược trend lớn. Chạy trên dữ liệu 1m local. Xem <code className="text-accent">docs/strategy/mean-reversion-v1.md</code>.
        </p>
      </div>

      {/* Universe + Regime */}
      <div className="card space-y-3">
        <div className="text-xs text-accent uppercase font-semibold">🎯 Universe &amp; Regime</div>
        <div className="grid md:grid-cols-2 gap-4">
          <Field label="Lọc symbol (trống = theo Top thanh khoản)">
            <input className="input" placeholder="VD: SOLUSDT, LINKUSDT" value={localSymbols} onChange={(e) => setLocalSymbols(e.target.value)} disabled={loading} />
            <div className="flex gap-2 flex-wrap mt-1 items-center">
              <button type="button" className="btn btn-ghost text-xs py-0.5 px-2" onClick={() => setLocalSymbols(MAJORS.join(", "))} disabled={loading}>🏆 Majors</button>
              {localSymbols && <button type="button" className="btn btn-ghost text-xs py-0.5 px-2" onClick={() => setLocalSymbols("")} disabled={loading}>✕</button>}
              {!localSymbols && (
                <label className="text-[11px] text-gray-400 flex items-center gap-1 ml-auto">Top thanh khoản
                  <select className="input py-0.5 w-auto" value={topLiquidity} onChange={(e) => setTopLiquidity(Number(e.target.value))} disabled={loading}>
                    {[20, 30, 40, 50, 75, 100, 0].map((o) => <option key={o} value={o}>{o === 0 ? "Tất cả" : `Top ${o}`}</option>)}
                  </select>
                </label>
              )}
            </div>
            <p className="text-[11px] text-gray-500 mt-1">{localCount ?? "?"} coin local · alt {modeInfo.altIv} · regime BTC {modeInfo.regimeIv}</p>
          </Field>
          <TimeRangePicker mode={rangeMode} setMode={setRangeMode} months={months} setMonths={setMonths} year={year} setYear={setYear}
            monthsSel={monthsSel} setMonthsSel={setMonthsSel} yearsSel={yearsSel} setYearsSel={setYearsSel} dataRange={dataRange} clampToData disabled={loading} />
        </div>
        <div className="flex flex-wrap items-end gap-x-4 gap-y-2 border-t border-border pt-3">
          <Field label="Cặp khung (regime → alt)">
            <select className="input min-w-[14rem]" value={regimeMode} onChange={(e) => setRegimeMode(e.target.value as RegimeMode)} disabled={loading}>
              {REGIME_MODES.map((m) => <option key={m.mode} value={m.mode}>{m.label}</option>)}
            </select>
          </Field>
          <Field label="EMA regime"><input type="number" className="input w-24" value={regimeEmaPeriod} onChange={(e) => setRegimeEmaPeriod(Number(e.target.value))} disabled={loading} /></Field>
          <label className="flex items-center gap-2 text-xs text-gray-300 self-center">
            <input type="checkbox" checked={useRegime} onChange={(e) => setUseRegime(e.target.checked)} disabled={loading} /> Cổng regime BTC
          </label>
          <label className="flex items-center gap-2 text-xs text-gray-300 self-center">
            <input type="checkbox" checked={allowLong} onChange={(e) => setAllowLong(e.target.checked)} disabled={loading} /> LONG
          </label>
          <label className="flex items-center gap-2 text-xs text-gray-300 self-center">
            <input type="checkbox" checked={allowShort} onChange={(e) => setAllowShort(e.target.checked)} disabled={loading} /> SHORT
          </label>
        </div>
      </div>

      {/* Tham số MR */}
      <div className="card space-y-3">
        <div className="text-xs text-accent uppercase font-semibold">⚙ Tham số Mean Reversion</div>
        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3">
          <Field label="N (SMA/std)" hint="Cửa sổ tính fair value + z-score"><input type="number" className="input" value={mr.n} onChange={(e) => setM("n", e.target.value)} /></Field>
          <Field label="Z vào" hint="|z| ≥ mức này mới vào (lệch chuẩn)"><input type="number" step="0.1" className="input" value={mr.zEntry} onChange={(e) => setM("zEntry", e.target.value)} /></Field>
          <Field label="Z chốt phần 1" hint="Chốt 50% khi |z| hồi về mức này"><input type="number" step="0.1" className="input" value={mr.zPartial} onChange={(e) => setM("zPartial", e.target.value)} /></Field>
          <Field label="Z chốt hết (TP)" hint="Chốt hết khi z về mức này (−1 = chốt sớm, win-rate cao hơn; 0 = về mean)"><input type="number" step="0.1" className="input" value={mr.zTp} onChange={(e) => setM("zTp", e.target.value)} /></Field>
          <Field label="Z-stop" hint="|z| vượt mức này → luận điểm sai, cắt"><input type="number" step="0.1" className="input" value={mr.zStop} onChange={(e) => setM("zStop", e.target.value)} /></Field>
          <Field label="SL k·ATR" hint="Hard stop = entry ∓ k·ATR (kết hợp swing)"><input type="number" step="0.1" className="input" value={mr.kSl} onChange={(e) => setM("kSl", e.target.value)} /></Field>
          <Field label="Time stop (nến)" hint="Chưa hồi sau N nến → thoát (MR phải hồi nhanh)"><input type="number" className="input" value={mr.timeStopBars} onChange={(e) => setM("timeStopBars", e.target.value)} /></Field>
          <Field label="RSI low / high" hint="Long cần RSI≤low; short cần RSI≥high"><div className="flex gap-1"><input type="number" className="input" value={mr.rsiLow} onChange={(e) => setM("rsiLow", e.target.value)} /><input type="number" className="input" value={mr.rsiHigh} onChange={(e) => setM("rsiHigh", e.target.value)} /></div></Field>
          <Field label="ADX max" hint="Regime range: ADX ≤ mức này (đo ở bar trước spike)"><input type="number" className="input" value={mr.adxMax} onChange={(e) => setM("adxMax", e.target.value)} /></Field>
          <Field label="Choppiness min" hint="Regime range: CI ≥ mức này (cao = đi ngang)"><input type="number" className="input" value={mr.chopMin} onChange={(e) => setM("chopMin", e.target.value)} /></Field>
          <Field label="Volume spike ×" hint="Yêu cầu volume ≥ ×SMA20 (0 = tắt; backtest cho thấy tắt tốt hơn)"><input type="number" step="0.1" className="input" value={mr.volSpike} onChange={(e) => setM("volSpike", e.target.value)} /></Field>
          <Field label="ATR% min/max" hint="Lọc coin quá chết / quá điên"><div className="flex gap-1"><input type="number" step="0.1" className="input" value={mr.atrPctMin} onChange={(e) => setM("atrPctMin", e.target.value)} /><input type="number" step="0.5" className="input" value={mr.atrPctMax} onChange={(e) => setM("atrPctMax", e.target.value)} /></div></Field>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3 border-t border-border pt-3">
          <Field label="Rủi ro/lệnh %"><select className="input" value={riskPerTradePct} onChange={(e) => setRisk(Number(e.target.value))} disabled={loading}>{[0.25, 0.5, 1, 1.5, 2].map((o) => <option key={o} value={o}>{o}</option>)}</select></Field>
          <Field label="Trần lệnh đồng thời"><select className="input" value={maxConcurrentPositions} onChange={(e) => setMaxConc(Number(e.target.value))} disabled={loading}>{[5, 10, 15, 20, 30, 50, 0].map((o) => <option key={o} value={o}>{o === 0 ? "∞" : o}</option>)}</select></Field>
          <Field label="Đòn bẩy"><select className="input" value={leverage} onChange={(e) => setLeverage(Number(e.target.value))} disabled={loading}>{[1, 2, 3, 5].map((o) => <option key={o} value={o}>{o}x</option>)}</select></Field>
          <Field label="Phí %/chiều"><select className="input" value={feePct} onChange={(e) => setFeePct(Number(e.target.value))} disabled={loading}>{[0, 0.02, 0.045, 0.05, 0.075].map((o) => <option key={o} value={o}>{o}%</option>)}</select></Field>
          <Field label="Trượt %/chiều"><select className="input" value={slippagePct} onChange={(e) => setSlippagePct(Number(e.target.value))} disabled={loading}>{[0, 0.01, 0.02, 0.05].map((o) => <option key={o} value={o}>{o}%</option>)}</select></Field>
        </div>
        <label className="flex items-center gap-2 text-xs text-gray-300">
          <input type="checkbox" checked={useDdBreaker} onChange={(e) => setUseDdBreaker(e.target.checked)} disabled={loading} />
          Circuit breaker DD (ngừng mở khi DD ≥
          <select className="input py-0.5 w-auto" value={ddHaltPct} onChange={(e) => setDdHaltPct(Number(e.target.value))} disabled={loading || !useDdBreaker}>{[15, 18, 20, 25, 30].map((o) => <option key={o} value={o}>{o}%</option>)}</select>)
        </label>
      </div>

      {/* Grid */}
      <div className="card space-y-2">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs text-accent uppercase font-semibold mr-auto">🔎 Grid search MR (n × zEntry × zStop × timeStop × ADXmax)</span>
          <button className="btn btn-primary" onClick={runGrid} disabled={gridLoading || loading}>{gridLoading ? "Đang quét..." : "🔎 Tìm bộ tốt nhất"}</button>
        </div>
        {gridProgress && (
          <div className="space-y-1">
            <div className="flex justify-between text-xs text-gray-400"><span>{gridProgress.done}/{gridProgress.total || "?"} tổ hợp{gridProgress.label ? ` · ${gridProgress.label}` : ""}</span><span>{gridProgress.total ? Math.round((gridProgress.done / gridProgress.total) * 100) : 0}%</span></div>
            <div className="w-full h-2 bg-panel2 rounded overflow-hidden"><div className="h-full bg-accent transition-all" style={{ width: `${gridProgress.total ? (gridProgress.done / gridProgress.total) * 100 : 0}%` }} /></div>
          </div>
        )}
        {grid && grid.best && (
          <div className="rounded-lg border border-accent bg-panel2 p-2 flex items-center justify-between gap-2 flex-wrap text-sm">
            <span>🏆 Tốt nhất: <b>n{grid.best.n} · z{grid.best.zEntry} · zStop{grid.best.zStop} · TS{grid.best.timeStopBars} · ADX≤{grid.best.adxMax}</b> · Calmar <b>{grid.best.calmar}</b> · ROI <b className={grid.best.roiPct >= 0 ? "text-up" : "text-down"}>{grid.best.roiPct}%</b> · MaxDD <b className="text-down">{grid.best.maxDrawdownPct}%</b> · PF {grid.best.profitFactor} · {grid.best.trades} lệnh</span>
            <button className="btn btn-primary text-xs" onClick={() => applyGridRow(grid.best!)}>Nạp bộ này</button>
          </div>
        )}
        {grid && (
          <div className="overflow-x-auto">
            <table className="resp-table w-full min-w-[720px] text-xs">
              <thead><tr>{["#", "N", "zEntry", "zStop", "TS", "ADX≤", "Lệnh", "Win%", "ROI%", "MaxDD%", "Calmar", "PF", ""].map((h) => <th key={h} className="th">{h}</th>)}</tr></thead>
              <tbody>
                {grid.ranked.map((r, i) => (
                  <tr key={i} className="hover:bg-panel2">
                    <td className="td">{i + 1}</td><td className="td">{r.n}</td><td className="td">{r.zEntry}</td><td className="td">{r.zStop}</td><td className="td">{r.timeStopBars}</td><td className="td">{r.adxMax}</td>
                    <td className="td">{r.trades}</td><td className="td">{r.winRate}</td>
                    <td className={`td ${r.roiPct >= 0 ? "text-up" : "text-down"}`}>{r.roiPct}</td><td className="td text-down">{r.maxDrawdownPct}</td>
                    <td className="td">{r.calmar ?? "—"}</td><td className="td">{r.profitFactor}</td>
                    <td className="td"><button className="btn btn-ghost text-xs py-0.5 px-2" onClick={() => applyGridRow(r)}>Nạp</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Run */}
      <div className="card space-y-3">
        <button className="btn btn-primary" onClick={runBacktest} disabled={loading}>
          {loading ? "Đang chạy..." : `🧪 Backtest MR → ${modeInfo.altIv} · z${mr.zEntry} · ${allowLong ? "L" : ""}${allowShort ? "S" : ""}`}
        </button>
        {progress && (
          <div className="space-y-1">
            <div className="flex justify-between text-xs text-gray-400"><span>{progress.done}/{progress.total || "?"} symbol{progress.symbol ? ` · ${progress.symbol}` : ""}</span><span>{progress.total ? Math.round((progress.done / progress.total) * 100) : 0}%</span></div>
            <div className="w-full h-2 bg-panel2 rounded overflow-hidden"><div className="h-full bg-accent transition-all" style={{ width: `${progress.total ? (progress.done / progress.total) * 100 : 0}%` }} /></div>
          </div>
        )}
      </div>

      {result && (
        <>
          <div className="card flex items-center justify-between gap-2 flex-wrap py-2">
            <span className="text-sm text-gray-300">Kết quả: <b>{result.totalTrades}</b> lệnh · Win <b>{result.winRate.toFixed(1)}%</b> · ROI <b className={result.roiPct >= 0 ? "text-up" : "text-down"}>{result.roiPct}%</b> · MaxDD <b className="text-down">{result.maxDrawdownPct}%</b> · PF <b>{result.profitFactor}</b></span>
            <button className="btn btn-primary" onClick={saveResult} disabled={saving || !runParams}>{saving ? "Đang lưu..." : "💾 Lưu lịch sử"}</button>
          </div>
          <BacktestResults result={result} emptyHint="Không có tín hiệu MR — thử hạ zEntry/nới RSI, hoặc chọn kỳ sideway rõ hơn." />
        </>
      )}

      <SavedBacktestHistory refreshKey={historyKey} strategy="MEANREV" onOpen={openRecord} />
    </div>
  );
}
