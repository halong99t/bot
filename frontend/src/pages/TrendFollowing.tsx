import { useState, useEffect, type ReactNode } from "react";
import { toast } from "sonner";
import { api } from "../api/client";
import Tooltip from "../components/Tooltip";
import BacktestResults from "../components/BacktestResults";
import TimeRangePicker from "../components/TimeRangePicker";
import SavedBacktestHistory from "../components/SavedBacktestHistory";
import type { BacktestResult, BacktestHistoryItem, GridResult, GridRow } from "../types";

const TIMEFRAMES = ["15m", "1h", "4h", "1d"] as const;
type Timeframe = (typeof TIMEFRAMES)[number];

// Ô nhập có nhãn
function Field({ label, hint, children, className }: { label: string; hint?: string; children: ReactNode; className?: string }) {
  return (
    <div className={`space-y-1 ${className ?? ""}`}>
      <label className="text-xs text-gray-400 uppercase flex items-center">
        {label}
        {hint ? (
          <Tooltip text={hint}>
            <span className="ml-1 text-gray-500 cursor-help">ⓘ</span>
          </Tooltip>
        ) : null}
      </label>
      {children}
    </div>
  );
}

function Seg({ active, onClick, disabled, children }: { active: boolean; onClick: () => void; disabled?: boolean; children: ReactNode }) {
  return (
    <button onClick={onClick} disabled={disabled} className={`btn ${active ? "btn-primary" : "btn-ghost"}`}>
      {children}
    </button>
  );
}

// Bộ tham số gợi ý cho chiến lược trend
type PresetCfg = {
  topLiquidity?: number; cooldownBars?: number; allowLong?: boolean; allowShort?: boolean;
  regimeMode?: RegimeMode; symbols?: string[]; // timeframe + rổ coin theo preset
  regimeEmaPeriod?: number; useRegimeBreadth?: boolean; useRegimeSlope?: boolean; regimeBreadthMin?: number;
  riskPerTradePct?: number; maxConcurrentPositions?: number; leverage?: number; compounding?: boolean;
  useDdBreaker?: boolean; ddReducePct?: number; ddReduceFactor?: number; ddHaltPct?: number; ddResumePct?: number;
  useCorrelationCap?: boolean; maxPerCluster?: number; corrThreshold?: number;
  useEntryScore?: boolean; entryScoreMin?: number; dailyLossLimitPct?: number; // Phase 1
};
type Preset = {
  name: string;
  desc: string;
  p: Partial<TrendForm>;
  useDonchianExit?: boolean; // preset có thể tắt Donchian-exit (mặc định bật)
  cfg?: PresetCfg; // regime + sizing + risk mgmt + universe (ngoài tham số tín hiệu)
};
// Tối ưu tần suất NGÀY (12 tháng, GA): tối đa số ngày có lệnh mà VẪN có lãi (gate PF≥1.2).
// LƯU Ý QUAN TRỌNG: "ngày nào cũng có lệnh" + có lãi là BẤT KHẢ THI — edge đòi chọn lọc.
// Đây là mức phủ ngày CAO NHẤT vẫn giữ lãi. Xem cột "Theo ngày" trong kết quả để thấy coverage thực.
const PRESETS: Preset[] = [
  {
    name: "🤖 Bot 15m + EntryScore≥65 (PF 2.07)",
    desc: "Bot vận hành hằng ngày · 15m · LONG · rổ ETH/XRP/HYPE/DOGE · Entry Score ≥65 (xác nhận volume, cắt fake breakout) · risk 2% · lev x10 · ddHalt 30. 6 tháng: PF 2.07 · Sharpe 2.38 · WR 50% · MaxDD 12.7% · ROI ~+76%.",
    p: { dcEntry: 72, dcExit: 31, emaFast: 10, emaSlow: 48, emaTrend: 170, adxMin: 19, atrPeriod: 10, k1Atr: 3.43, k2Atr: 4.57, timeStopBars: 1820, atrPctMin: 0.53, atrPctMax: 8.1 },
    useDonchianExit: true,
    cfg: {
      regimeMode: "BTC1H_ALT15M", symbols: ["ETHUSDT", "XRPUSDT", "HYPEUSDT", "DOGEUSDT"],
      cooldownBars: 6, allowLong: true, allowShort: false,
      regimeEmaPeriod: 50, useRegimeBreadth: false, useRegimeSlope: false,
      riskPerTradePct: 2, maxConcurrentPositions: 6, leverage: 10, compounding: false,
      useDdBreaker: true, ddReducePct: 15, ddReduceFactor: 0.5, ddHaltPct: 30, ddResumePct: 15,
      useCorrelationCap: false,
      useEntryScore: true, entryScoreMin: 65,
    },
  },
];

// Universe CỐ ĐỊNH — chỉ đánh đúng các coin này (HYPE chưa có dữ liệu 1m local → tự bị loại).
const FIXED_UNIVERSE = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT", "HYPEUSDT", "DOGEUSDT", "TRXUSDT"];


interface TrendForm {
  dcEntry: number;
  dcExit: number;
  emaFast: number;
  emaSlow: number;
  emaTrend: number;
  adxMin: number;
  atrPeriod: number;
  k1Atr: number;
  k2Atr: number;
  timeStopBars: number;
  atrPctMin: number;
  atrPctMax: number;
}

const regimeColor = (r: string) => (r === "LONG" ? "text-up" : r === "SHORT" ? "text-down" : "text-gray-400");

type RegimeMode = "BTC1H_ALT1H" | "BTC1H_ALT15M";
const REGIME_MODES: { mode: RegimeMode; label: string; altIv: Timeframe; regimeIv: string }[] = [
  { mode: "BTC1H_ALT15M", label: "BTC 1h → đánh alt 15m", altIv: "15m", regimeIv: "1h" },
  { mode: "BTC1H_ALT1H", label: "BTC 1h → đánh alt 1h", altIv: "1h", regimeIv: "1h" },
];

export default function TrendFollowing() {
  // Cặp regime↔alt (thay cho việc chọn khung rời)
  const [regimeMode, setRegimeMode] = useState<RegimeMode>("BTC1H_ALT1H");
  const [universe, setUniverse] = useState<string[]>(FIXED_UNIVERSE); // rổ coin (preset có thể đổi)
  const modeInfo = REGIME_MODES.find((m) => m.mode === regimeMode)!;
  const interval = modeInfo.altIv; // khung nến alt suy từ mode
  const regimeIv = modeInfo.regimeIv; // khung BTC regime
  const [tp, setTp] = useState<TrendForm>({
    dcEntry: 150,
    dcExit: 75,
    emaFast: 20,
    emaSlow: 50,
    emaTrend: 200,
    adxMin: 20,
    atrPeriod: 14,
    k1Atr: 3,
    k2Atr: 6,
    timeStopBars: 2000,
    atrPctMin: 0.5,
    atrPctMax: 8,
  });
  const setTP = (k: keyof TrendForm, v: string) => setTp((f) => ({ ...f, [k]: Number(v) }));

  // Hướng & regime
  const [allowLong, setAllowLong] = useState(true);
  const [allowShort, setAllowShort] = useState(false);
  const [useRegime, setUseRegime] = useState(true);
  const [useRegimeExit, setUseRegimeExit] = useState(true);
  const [useDonchianExit, setUseDonchianExit] = useState(false); // mặc định khớp preset "Thả lời chạy"
  const [cooldownBars, setCooldownBars] = useState(0); // nến chờ sau khi thoát mới vào lại
  // Chiến lược: "trend" (chỉ Donchian breakout) hoặc "router" (Trend + Mean-Reversion gộp 1 portfolio).
  const [strategyMode, setStrategyMode] = useState<"trend" | "router">("trend");
  const [useEntryScore, setUseEntryScore] = useState(false); // Phase 1: chấm điểm entry 0–100
  const [entryScoreMin, setEntryScoreMin] = useState(65);
  const [dailyLossLimitPct, setDailyLossLimitPct] = useState(0); // 0 = tắt
  const [regimeEmaPeriod, setRegimeEmaPeriod] = useState(200);
  const [regimeSource, setRegimeSource] = useState<"local" | "binance">("local");
  const [useRegimeSlope, setUseRegimeSlope] = useState(false);
  const [regimeSlopeLookback, setRegimeSlopeLookback] = useState(20);
  const [useRegimeBreadth, setUseRegimeBreadth] = useState(false);
  const [regimeBreadthMin, setRegimeBreadthMin] = useState(0.5);

  // Sizing / danh mục
  const [initialCapitalUsdt, setInitialCapital] = useState(10000);
  const [riskPerTradePct, setRisk] = useState(0.5);
  const [maxConcurrentPositions, setMaxConc] = useState(15);
  const [maxPortfolioRiskPct, setMaxPortRisk] = useState(8);
  const [leverage, setLeverage] = useState(5);
  const [marginMode, setMarginMode] = useState<"CROSS" | "ISOLATED">("CROSS");
  const [compounding, setCompounding] = useState(false);

  // Chi phí
  const [feePct, setFeePct] = useState(0.045);
  const [slippagePct, setSlippagePct] = useState(0.02);
  const [useRealFunding, setUseRealFunding] = useState(false);

  // Risk management: circuit breaker DD + correlation cap
  const [useDdBreaker, setUseDdBreaker] = useState(true);
  const [ddReducePct, setDdReducePct] = useState(15);
  const [ddReduceFactor, setDdReduceFactor] = useState(0.5);
  const [ddHaltPct, setDdHaltPct] = useState(20);
  const [ddResumePct, setDdResumePct] = useState(10);
  const [useCorrelationCap, setUseCorrelationCap] = useState(true);
  const [maxPerCluster, setMaxPerCluster] = useState(2);
  const [corrThreshold, setCorrThreshold] = useState(0.8);

  // Symbol + thời gian
  const [localCount, setLocalCount] = useState<number | null>(null);
  const [topLiquidity, setTopLiquidity] = useState(10); // khoá Top-10 thanh khoản cao nhất
  const [cacheInfo, setCacheInfo] = useState<{ cached: number; total: number; building: boolean } | null>(null);
  const [rangeMode, setRangeMode] = useState<"recent" | "year" | "custom">("recent");
  const [months, setMonths] = useState(6);
  const [year, setYear] = useState(2025);
  const [monthsSel, setMonthsSel] = useState<number[]>([]);
  const [yearsSel, setYearsSel] = useState<number[]>([2024]);
  const [dataRange, setDataRange] = useState<{ minTs: number; maxTs: number } | null>(null);

  // Regime widget
  const [regimeInfo, setRegimeInfo] = useState<Awaited<ReturnType<typeof api.fetchBtcRegime>> | null>(null);
  const [regimeLoading, setRegimeLoading] = useState(false);

  // Kết quả
  const [result, setResult] = useState<BacktestResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number; symbol?: string } | null>(null);
  const [runParams, setRunParams] = useState<Record<string, unknown> | null>(null);
  const [saving, setSaving] = useState(false);
  const [historyKey, setHistoryKey] = useState(0);

  // Grid search
  const [grid, setGrid] = useState<GridResult | null>(null);
  const [gridProgress, setGridProgress] = useState<{ done: number; total: number; label?: string } | null>(null);
  const [gridLoading, setGridLoading] = useState(false);
  const [optimizeRegimeEma, setOptimizeRegimeEma] = useState(true); // quét thêm EMA regime BTC

  useEffect(() => {
    api.getLocalSymbols().then((d) => setLocalCount(d.count)).catch(() => setLocalCount(0));
    api
      .getLocalRange()
      .then((r) => {
        if (r.maxTs > 0) {
          setDataRange(r);
          const maxD = new Date(r.maxTs);
          setYear(maxD.getUTCFullYear());
          setYearsSel([maxD.getUTCFullYear()]);
        }
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    let stop = false;
    const tick = async () => {
      try {
        const s = await api.getCacheStatus(interval);
        if (!stop) setCacheInfo({ cached: s.cached, total: s.total, building: s.building });
      } catch {
        /* ignore */
      }
    };
    tick();
    const t = window.setInterval(tick, 4000);
    return () => {
      stop = true;
      window.clearInterval(t);
    };
  }, [interval]);

  const applyPreset = (p: Preset) => {
    setTp((f) => ({ ...f, ...p.p }));
    setUseDonchianExit(p.useDonchianExit ?? true);
    const c = p.cfg;
    if (c) {
      setRegimeMode(c.regimeMode ?? "BTC1H_ALT1H"); // reset timeframe theo preset
      setUniverse(c.symbols ?? FIXED_UNIVERSE); // reset rổ coin theo preset
      if (c.topLiquidity !== undefined) setTopLiquidity(c.topLiquidity);
      if (c.cooldownBars !== undefined) setCooldownBars(c.cooldownBars);
      setUseEntryScore(c.useEntryScore ?? false);
      if (c.entryScoreMin !== undefined) setEntryScoreMin(c.entryScoreMin);
      if (c.dailyLossLimitPct !== undefined) setDailyLossLimitPct(c.dailyLossLimitPct);
      // Reset chiều về long-only mặc định trừ khi preset chỉ định (tránh rò allowShort giữa các preset)
      setAllowLong(c.allowLong ?? true);
      setAllowShort(c.allowShort ?? false);
      if (c.regimeEmaPeriod !== undefined) setRegimeEmaPeriod(c.regimeEmaPeriod);
      if (c.useRegimeBreadth !== undefined) setUseRegimeBreadth(c.useRegimeBreadth);
      if (c.useRegimeSlope !== undefined) setUseRegimeSlope(c.useRegimeSlope);
      if (c.regimeBreadthMin !== undefined) setRegimeBreadthMin(c.regimeBreadthMin);
      if (c.riskPerTradePct !== undefined) setRisk(c.riskPerTradePct);
      if (c.maxConcurrentPositions !== undefined) setMaxConc(c.maxConcurrentPositions);
      if (c.leverage !== undefined) setLeverage(c.leverage);
      if (c.compounding !== undefined) setCompounding(c.compounding);
      if (c.useDdBreaker !== undefined) setUseDdBreaker(c.useDdBreaker);
      if (c.ddReducePct !== undefined) setDdReducePct(c.ddReducePct);
      if (c.ddReduceFactor !== undefined) setDdReduceFactor(c.ddReduceFactor);
      if (c.ddHaltPct !== undefined) setDdHaltPct(c.ddHaltPct);
      if (c.ddResumePct !== undefined) setDdResumePct(c.ddResumePct);
      if (c.useCorrelationCap !== undefined) setUseCorrelationCap(c.useCorrelationCap);
      if (c.maxPerCluster !== undefined) setMaxPerCluster(c.maxPerCluster);
      if (c.corrThreshold !== undefined) setCorrThreshold(c.corrThreshold);
    }
    toast.success(`Đã nạp "${p.name.replace(/^[^ ]+ /, "")}" — bấm Backtest để chạy`);
  };

  // Khoảng thời gian đang chọn (dùng chung cho backtest / grid / kiểm tra regime)
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
    return { fromMs: toMs - months * 30 * 24 * 60 * 60 * 1000, toMs };
  };

  const checkRegime = async (silent = false) => {
    setRegimeLoading(true);
    try {
      const { fromMs, toMs } = currentRange();
      const r = await api.fetchBtcRegime({ interval: regimeIv, emaPeriod: regimeEmaPeriod, fromMs, toMs });
      setRegimeInfo(r);
      if (!silent) toast.success(`BTC regime: ${r.currentRegime} · ${r.candles} nến ${r.interval} (đúng khoảng test)`);
    } catch (e: any) {
      if (!silent) toast.error(e?.response?.data?.message ?? "Không kéo được BTC (kiểm tra mạng/Binance)");
    } finally {
      setRegimeLoading(false);
    }
  };

  // (Đã bỏ regime monitor widget → không auto-fetch regime nữa để tránh gọi API thừa.)

  const runBacktest = async () => {
    if (tp.emaFast >= tp.emaSlow) return toast.error("EMA Fast phải nhỏ hơn EMA Slow");
    if (!allowLong && !allowShort) return toast.error("Bật ít nhất 1 hướng (Long/Short)");

    let fromMs: number | undefined;
    let toMs: number | undefined;
    if (rangeMode === "custom") {
      if (!monthsSel.length) return toast.error("Chọn ít nhất 1 tháng");
      const s = [...monthsSel].sort((a, b) => a - b);
      fromMs = new Date(year, s[0] - 1, 1).getTime();
      toMs = new Date(year, s[s.length - 1], 1).getTime();
    } else if (rangeMode === "year") {
      if (!yearsSel.length) return toast.error("Chọn ít nhất 1 năm");
      const ys = [...yearsSel].sort((a, b) => a - b);
      fromMs = new Date(ys[0], 0, 1).getTime();
      toMs = new Date(ys[ys.length - 1] + 1, 0, 1).getTime();
    } else {
      toMs = Date.now();
      fromMs = toMs - months * 30 * 24 * 60 * 60 * 1000;
    }

    const symbols = universe;

    setLoading(true);
    setError(null);
    setResult(null);
    setProgress({ done: 0, total: 0 });
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const body: Record<string, unknown> = {
      interval,
      regimeMode,
      ...tp,
      allowLong,
      allowShort,
      useRegime,
      useRegimeExit,
      useDonchianExit,
      cooldownBars,
      useEntryScore,
      entryScoreMin,
      dailyLossLimitPct: useEntryScore || dailyLossLimitPct ? dailyLossLimitPct : 0,
      regimeEmaPeriod,
      regimeSource,
      useRegimeSlope,
      regimeSlopeLookback,
      useRegimeBreadth,
      regimeBreadthMin,
      riskPerTradePct,
      maxConcurrentPositions,
      maxPortfolioRiskPct,
      initialCapitalUsdt,
      leverage,
      marginMode,
      compounding,
      feePct,
      slippagePct,
      useRealFunding,
      topLiquidity,
      // Risk management
      ddReducePct: useDdBreaker ? ddReducePct : 0,
      ddReduceFactor,
      ddHaltPct: useDdBreaker ? ddHaltPct : 0,
      ddResumePct: useDdBreaker ? ddResumePct : 0,
      useCorrelationCap,
      maxPerCluster: useCorrelationCap ? maxPerCluster : 0,
      corrThreshold,
      fromMs,
      toMs,
      symbols: symbols.length ? symbols : undefined,
    };
    if (strategyMode === "router") {
      body.useTrend = true;
      body.useMeanRev = true; // nhánh mean-rev tự giới hạn vào bối cảnh RANGE (ADX thấp)
    }
    try {
      const { jobId, total } =
        strategyMode === "router" ? await api.runRouterBacktest(body) : await api.runTrendBacktest(body);
      setProgress({ done: 0, total });
      for (let i = 0; i < 8000; i++) {
        const job = await api.getBacktestJob(jobId);
        setProgress({ done: job.progress, total: job.total, symbol: job.currentSymbol });
        if (job.status === "done" && job.result) {
          setResult(job.result);
          setRunParams(body);
          toast.success(`${job.result.totalTrades} lệnh · ROI ${job.result.roiPct}%`);
          break;
        }
        if (job.status === "error") {
          setError(job.error ?? "lỗi");
          break;
        }
        await sleep(700);
      }
    } catch (e: any) {
      setError(e?.response?.data?.message ?? e?.message ?? "Backtest Trend thất bại");
    } finally {
      setLoading(false);
      setProgress(null);
    }
  };

  // Chạy grid search tìm bộ tham số tốt nhất (theo Calmar), trên cùng rổ/khoảng đang chọn.
  const runGrid = async () => {
    if (!allowLong && !allowShort) return toast.error("Bật ít nhất 1 hướng (Long/Short)");
    let fromMs: number | undefined;
    let toMs: number | undefined;
    if (rangeMode === "custom" && monthsSel.length) {
      const s = [...monthsSel].sort((a, b) => a - b);
      fromMs = new Date(year, s[0] - 1, 1).getTime();
      toMs = new Date(year, s[s.length - 1], 1).getTime();
    } else if (rangeMode === "year" && yearsSel.length) {
      const ys = [...yearsSel].sort((a, b) => a - b);
      fromMs = new Date(ys[0], 0, 1).getTime();
      toMs = new Date(ys[ys.length - 1] + 1, 0, 1).getTime();
    } else {
      toMs = Date.now();
      fromMs = toMs - months * 30 * 24 * 60 * 60 * 1000;
    }
    const symbols = universe;
    setGridLoading(true);
    setGrid(null);
    setGridProgress({ done: 0, total: 0 });
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    try {
      const { jobId, total } = await api.runTrendGrid({
        regimeMode,
        allowLong,
        allowShort,
        useRegime,
        useRegimeExit,
        useDonchianExit,
        cooldownBars,
        useEntryScore,
        entryScoreMin,
        regimeEmaPeriod,
        riskPerTradePct,
        maxConcurrentPositions,
        initialCapitalUsdt,
        leverage,
        compounding,
        feePct,
        slippagePct,
        topLiquidity,
        atrPeriod: tp.atrPeriod,
        emaFast: tp.emaFast,
        emaSlow: tp.emaSlow,
        emaTrend: tp.emaTrend,
        timeStopBars: tp.timeStopBars,
        fromMs,
        toMs,
        symbols: symbols.length ? symbols : undefined,
        grid: optimizeRegimeEma ? { regimeEma: [50, 100, 150, 200, 250, 300] } : undefined,
      });
      setGridProgress({ done: 0, total });
      for (let i = 0; i < 20000; i++) {
        const job = await api.getBacktestJob(jobId);
        setGridProgress({ done: job.progress, total: job.total, label: job.currentSymbol });
        if (job.status === "done" && job.gridResult) {
          const gr = job.gridResult as GridResult;
          setGrid(gr);
          const b = gr.best;
          toast.success(b ? `Tốt nhất: DC${b.dcEntry} k1=${b.k1Atr} k2=${b.k2Atr} ADX>${b.adxMin} · Calmar ${b.calmar}` : "Không có combo hợp lệ");
          break;
        }
        if (job.status === "error") {
          toast.error(job.error ?? "Grid lỗi");
          break;
        }
        await sleep(1000);
      }
    } catch (e: any) {
      toast.error(e?.response?.data?.message ?? "Grid thất bại");
    } finally {
      setGridLoading(false);
      setGridProgress(null);
    }
  };

  // Nạp 1 dòng grid vào form tham số (gồm cả EMA regime BTC)
  const applyGridRow = (r: GridRow) => {
    setTp((f) => ({ ...f, dcEntry: r.dcEntry, dcExit: r.dcExit, k1Atr: r.k1Atr, k2Atr: r.k2Atr, adxMin: r.adxMin }));
    setRegimeEmaPeriod(r.regimeEma);
    toast.success(`Đã nạp DC${r.dcEntry}/${r.dcExit} · k1=${r.k1Atr} · k2=${r.k2Atr} · ADX>${r.adxMin} · EMA-BTC ${r.regimeEma}`);
  };

  const saveResult = async () => {
    if (!result || !runParams) return;
    setSaving(true);
    try {
      const { count } = await api.saveBacktestHistory({
        params: runParams,
        interval: (runParams.interval as string) ?? interval,
        strategy: "TREND",
        result,
      });
      toast.success(`Đã lưu lịch sử TREND [${runParams.interval ?? interval}] — tách ${count} tháng`);
      setHistoryKey((k) => k + 1);
    } catch (e: any) {
      toast.error(e?.response?.data?.message ?? "Lưu lịch sử thất bại");
    } finally {
      setSaving(false);
    }
  };

  const openRecord = async (item: BacktestHistoryItem) => {
    try {
      const full = await api.getBacktestHistory(item.id);
      if (full.result) {
        setResult(full.result);
        setRunParams(full.params as Record<string, unknown>);
        toast.success(`Đã mở lịch sử [${item.interval}] năm ${item.year}`);
      }
    } catch {
      toast.error("Không mở được bản ghi");
    }
  };

  return (
    <div className="space-y-4">
      {/* Header */}
      <div>
        <h2 className="text-xl font-bold">Trend Following (Donchian Breakout + Regime)</h2>
        <p className="text-xs text-gray-400 mt-1 max-w-3xl">
          Vào lệnh khi giá đột phá kênh Donchian, có EMA + ADX xác nhận và cổng regime BTC. Thoát bằng
          stop ATR + Chandelier trailing + Donchian/time exit. Chạy trên dữ liệu 1m local; regime kéo BTC
          từ Binance. Xem <code className="text-accent">docs/strategy/trend-following-v1.md</code>.
        </p>
      </div>

      {/* Universe (symbol + khoảng thời gian) + Regime BTC — GỘP CHUNG */}
      <div className="card space-y-3">
        <div className="text-xs text-accent uppercase font-semibold">🎯 Universe &amp; Regime BTC</div>

        {/* Symbol + khoảng thời gian */}
        <div className="grid md:grid-cols-2 gap-4">
          <Field label={`Universe (${universe.length} coin · khung ${interval})`}>
            <div className="flex flex-wrap gap-1.5">
              {universe.map((c) => (
                <span key={c} className="text-xs px-2 py-1 rounded border border-border bg-panel2 text-gray-200">{c.replace("USDT", "")}</span>
              ))}
            </div>
            <p className="text-[11px] text-gray-500 mt-1">Rổ coin do preset đặt (đổi khi chọn preset khác).</p>
            {cacheInfo && (
              <p className="text-[11px] text-gray-500 mt-1">
                {cacheInfo.cached >= cacheInfo.total && cacheInfo.total > 0
                  ? `✓ Cache khung ${interval} sẵn sàng (${cacheInfo.cached}/${cacheInfo.total})`
                  : `⏳ Đang tạo cache nền: ${cacheInfo.cached}/${cacheInfo.total} coin`}
              </p>
            )}
          </Field>
          <TimeRangePicker
            mode={rangeMode}
            setMode={setRangeMode}
            months={months}
            setMonths={setMonths}
            year={year}
            setYear={setYear}
            monthsSel={monthsSel}
            setMonthsSel={setMonthsSel}
            yearsSel={yearsSel}
            setYearsSel={setYearsSel}
            dataRange={dataRange}
            clampToData
            disabled={loading}
          />
        </div>

        {/* Regime BTC (theo đúng khoảng thời gian ở trên) */}
        <div className="flex items-end gap-2 flex-wrap border-t border-border pt-3">
          <span className="text-xs text-accent uppercase font-semibold mr-auto">🧭 Regime BTC + khung đánh alt</span>
          <Field label="Cặp khung (regime → alt)">
            <select className="input min-w-[15rem]" value={regimeMode} onChange={(e) => setRegimeMode(e.target.value as RegimeMode)} disabled={loading}>
              {REGIME_MODES.map((m) => (
                <option key={m.mode} value={m.mode}>{m.label}</option>
              ))}
            </select>
          </Field>
          <Field label="EMA regime">
            <input type="number" className="input w-24" value={regimeEmaPeriod} onChange={(e) => setRegimeEmaPeriod(Number(e.target.value))} />
          </Field>
        </div>

        {/* Regime đa tầng */}
        <div className="flex flex-wrap items-end gap-x-4 gap-y-2 border-t border-border pt-3">
          <label className="flex items-center gap-2 text-xs text-gray-300 self-center">
            <input type="checkbox" checked={useRegimeSlope} onChange={(e) => setUseRegimeSlope(e.target.checked)} disabled={loading} />
            <Tooltip text="Chỉ LONG khi EMA regime đang DỐC LÊN (ema[i] > ema[i−N]); chỉ SHORT khi dốc xuống. Lọc giai đoạn EMA đi ngang.">
              <span>Yêu cầu EMA dốc ⓘ</span>
            </Tooltip>
          </label>
          {useRegimeSlope && (
            <Field label="Slope lookback (nến)">
              <input type="number" className="input w-24" value={regimeSlopeLookback} onChange={(e) => setRegimeSlopeLookback(Number(e.target.value))} disabled={loading} />
            </Field>
          )}
          <label className="flex items-center gap-2 text-xs text-gray-300 self-center">
            <input type="checkbox" checked={useRegimeBreadth} onChange={(e) => setUseRegimeBreadth(e.target.checked)} disabled={loading} />
            <Tooltip text="Chỉ LONG khi % coin trong universe nằm trên EMA của chính nó ≥ ngưỡng (breadth mạnh). Đo 'độ rộng' thị trường, không chỉ mình BTC.">
              <span>Yêu cầu breadth ⓘ</span>
            </Tooltip>
          </label>
          {useRegimeBreadth && (
            <Field label="Breadth min">
              <select className="input" value={regimeBreadthMin} onChange={(e) => setRegimeBreadthMin(Number(e.target.value))} disabled={loading}>
                {[0.4, 0.45, 0.5, 0.55, 0.6, 0.7].map((o) => <option key={o} value={o}>{Math.round(o * 100)}%</option>)}
              </select>
            </Field>
          )}
        </div>

        <p className="text-[11px] text-gray-500">
          Regime = close BTC <b>{regimeIv}</b> so EMA{regimeEmaPeriod} (dùng BTC local /1m, fallback Binance). Chỉ LONG khi
          regime LONG, SHORT khi regime SHORT. Khung nến đánh alt tự set theo cặp = <b>{interval}</b>.
        </p>
      </div>

      {/* Bộ gợi ý */}
      {PRESETS.length > 0 && (
        <div className="card space-y-2">
          <div className="text-[11px] text-gray-400 uppercase">⭐ Bộ tham số gợi ý</div>
          <div className="flex flex-wrap gap-2">
            {PRESETS.map((p) => (
              <Tooltip key={p.name} text={p.desc}>
                <button className="btn btn-ghost text-xs" onClick={() => applyPreset(p)} disabled={loading}>{p.name}</button>
              </Tooltip>
            ))}
          </div>
        </div>
      )}

      {/* Tham số chiến lược */}
      <div className="card space-y-3">
        <div className="flex items-center gap-2">
          <span className="text-xs text-accent uppercase font-semibold">⚙ Tham số chiến lược</span>
          {tp.emaFast >= tp.emaSlow && <span className="text-down text-xs">⚠ Fast phải nhỏ hơn Slow</span>}
        </div>
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
          <Field label="Khung alt (theo cặp)">
            <div className="input flex items-center text-gray-300 cursor-default">{interval} <span className="text-gray-500 ml-1 text-xs">· BTC {regimeIv}</span></div>
          </Field>
          <Field label="Donchian vào" hint="Số nến kênh breakout: đóng vượt đỉnh N nến → vào lệnh.">
            <input type="number" className="input" value={tp.dcEntry} onChange={(e) => setTP("dcEntry", e.target.value)} />
          </Field>
          <Field label="Donchian thoát" hint="Thủng đáy M nến → thoát (M ≤ dcEntry). Muốn TẮT hẳn donchian-exit: bỏ tick 'Donchian-exit' bên dưới.">
            <input type="number" className="input" value={tp.dcExit} onChange={(e) => setTP("dcExit", e.target.value)} disabled={!useDonchianExit} />
          </Field>
          <Field label="EMA Fast"><input type="number" className="input" value={tp.emaFast} onChange={(e) => setTP("emaFast", e.target.value)} /></Field>
          <Field label="EMA Slow"><input type="number" className="input" value={tp.emaSlow} onChange={(e) => setTP("emaSlow", e.target.value)} /></Field>
          <Field label="EMA Trend" hint="Trend nền: chỉ long khi giá > EMA này.">
            <input type="number" className="input" value={tp.emaTrend} onChange={(e) => setTP("emaTrend", e.target.value)} />
          </Field>
          <Field label="ADX min" hint="Chỉ vào khi ADX > ngưỡng (bỏ chop). 0 = tắt lọc.">
            <input type="number" className="input" value={tp.adxMin} onChange={(e) => setTP("adxMin", e.target.value)} />
          </Field>
          <Field label="ATR period"><input type="number" className="input" value={tp.atrPeriod} onChange={(e) => setTP("atrPeriod", e.target.value)} /></Field>
          <Field label="Stop k1·ATR" hint="Hard stop = entry ∓ k1×ATR. Định nghĩa 1R.">
            <input type="number" step="0.1" className="input" value={tp.k1Atr} onChange={(e) => setTP("k1Atr", e.target.value)} />
          </Field>
          <Field label="Trail k2·ATR" hint="Chandelier: HH − k2×ATR. k2 lớn = thả lời chạy xa hơn.">
            <input type="number" step="0.1" className="input" value={tp.k2Atr} onChange={(e) => setTP("k2Atr", e.target.value)} />
          </Field>
          <Field label="Entry Score min" hint="Chấm điểm entry 0–100 (ADX + volume + chất lượng breakout). Chỉ vào lệnh khi ≥ ngưỡng. Bật checkbox để dùng. ≥65 thường nâng PF & Sharpe rõ rệt (cắt fake breakout).">
            <div className="flex items-center gap-2">
              <input type="checkbox" checked={useEntryScore} onChange={(e) => setUseEntryScore(e.target.checked)} disabled={loading} />
              <input type="number" className="input" value={entryScoreMin} onChange={(e) => setEntryScoreMin(Number(e.target.value))} disabled={loading || !useEntryScore} min={0} max={100} />
            </div>
          </Field>
          <Field label="Daily loss limit (%)" hint="Ngừng mở lệnh mới khi lỗ realized trong NGÀY ≥ % vốn này. 0 = tắt. (bảo vệ chuỗi thua)">
            <input type="number" step="0.5" className="input" value={dailyLossLimitPct} onChange={(e) => setDailyLossLimitPct(Number(e.target.value))} disabled={loading} />
          </Field>
        </div>

        {/* Nâng cao (thu gọn) */}
        <details className="text-xs">
          <summary className="cursor-pointer text-gray-400 hover:text-gray-200 select-none uppercase">⚙ Nâng cao (time-stop · ATR% band · cooldown)</summary>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-2">
            <Field label="Time stop (nến)" hint="Giữ đủ số nến này mà lãi < 0.5R → đóng. Lớn = ít cắt sớm.">
              <input type="number" className="input" value={tp.timeStopBars} onChange={(e) => setTP("timeStopBars", e.target.value)} />
            </Field>
            <Field label="ATR% min" hint="Bỏ coin quá 'chết' (ATR/giá < min %).">
              <input type="number" step="0.1" className="input" value={tp.atrPctMin} onChange={(e) => setTP("atrPctMin", e.target.value)} />
            </Field>
            <Field label="ATR% max" hint="Bỏ coin biến động điên (ATR/giá > max %).">
              <input type="number" step="0.5" className="input" value={tp.atrPctMax} onChange={(e) => setTP("atrPctMax", e.target.value)} />
            </Field>
            <Field label="Cooldown (nến)" hint="Số nến chờ sau khi thoát mới được vào lại (chống re-entry churn). 0 = tắt.">
              <input type="number" className="input" value={cooldownBars} onChange={(e) => setCooldownBars(Number(e.target.value))} disabled={loading} />
            </Field>
          </div>
        </details>

        {/* Hướng + regime */}
        <div className="flex flex-wrap gap-4 border-t border-border pt-3">
          <label className="flex items-center gap-2 text-xs text-gray-300">
            <input type="checkbox" checked={allowLong} onChange={(e) => setAllowLong(e.target.checked)} disabled={loading} /> Cho phép LONG
          </label>
          <label className="flex items-center gap-2 text-xs text-gray-300">
            <input type="checkbox" checked={allowShort} onChange={(e) => setAllowShort(e.target.checked)} disabled={loading} />
            <Tooltip text="Bật cả LONG+SHORT: khi BTC regime=LONG → long alt breakout lên; khi regime=SHORT → SHORT alt breakout xuống (tự đổi chiều theo regime). Tắt = chỉ long, đứng ngoài lúc regime SHORT. Lưu ý: short alt kéo lùi hiệu suất giai đoạn bull, nhưng cứu giai đoạn bear/chop (12m gần đây +15% vs long-only −1%)."><span>Cho phép SHORT ⓘ</span></Tooltip>
          </label>
          <label className="flex items-center gap-2 text-xs text-gray-300">
            <input type="checkbox" checked={useRegime} onChange={(e) => setUseRegime(e.target.checked)} disabled={loading} />
            <Tooltip text="Chỉ long khi BTC > EMA (LONG_ON), chỉ short khi BTC < EMA. Tắt = không lọc regime."><span>Dùng regime BTC ⓘ</span></Tooltip>
          </label>
          <label className="flex items-center gap-2 text-xs text-gray-300">
            <input type="checkbox" checked={useRegimeExit} onChange={(e) => setUseRegimeExit(e.target.checked)} disabled={loading} /> Đóng khi regime lật
          </label>
          <label className="flex items-center gap-2 text-xs text-gray-300">
            <input type="checkbox" checked={useDonchianExit} onChange={(e) => setUseDonchianExit(e.target.checked)} disabled={loading} />
            <Tooltip text="Thoát khi thủng kênh Donchian(dcExit). Bỏ tick = TẮT hẳn donchian-exit (chỉ dựa stop/chandelier/regime/time)."><span>Donchian-exit ⓘ</span></Tooltip>
          </label>
        </div>
      </div>

      {/* Sizing + danh mục */}
      <div className="card space-y-3">
        <div className="text-xs text-accent uppercase font-semibold">💰 Vốn &amp; Rủi ro</div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Field label="Vốn ban đầu (USDT)">
            <select className="input" value={initialCapitalUsdt} onChange={(e) => setInitialCapital(Number(e.target.value))} disabled={loading}>
              {[1000, 2000, 5000, 10000, 50000, 100000].map((o) => <option key={o} value={o}>{o.toLocaleString()}</option>)}
            </select>
          </Field>
          <Field label="Rủi ro / lệnh (%)" hint="Mỗi lệnh rủi ro % số dư khi chạm stop (1R). Khối lượng = (số dư×%)/khoảng-stop.">
            <select className="input" value={riskPerTradePct} onChange={(e) => setRisk(Number(e.target.value))} disabled={loading}>
              {[0.25, 0.5, 1, 1.5, 2, 3].map((o) => <option key={o} value={o}>{o}</option>)}
            </select>
          </Field>
          <Field label="Trần lệnh đồng thời">
            <select className="input" value={maxConcurrentPositions} onChange={(e) => setMaxConc(Number(e.target.value))} disabled={loading}>
              {[5, 10, 15, 20, 30, 50, 100, 0].map((o) => <option key={o} value={o}>{o === 0 ? "∞" : o}</option>)}
            </select>
          </Field>
          <Field label="Trần rủi ro DM (%)" hint="Tổng rủi ro các vị thế mở ≤ % này (≈ giới hạn số lệnh = trần÷rủi-ro-mỗi-lệnh). 0 = ∞.">
            <select className="input" value={maxPortfolioRiskPct} onChange={(e) => setMaxPortRisk(Number(e.target.value))} disabled={loading}>
              {[0, 4, 6, 8, 10, 15, 20].map((o) => <option key={o} value={o}>{o === 0 ? "∞" : o}</option>)}
            </select>
          </Field>
          <Field label="Đòn bẩy (x)">
            <select className="input" value={leverage} onChange={(e) => setLeverage(Number(e.target.value))} disabled={loading}>
              {[1, 2, 3, 5, 10, 20, 25, 50, 75, 100].map((o) => <option key={o} value={o}>x{o}</option>)}
            </select>
          </Field>
          <Field label="Ký quỹ" hint="CROSS: cả số dư đỡ lệnh, SL bảo vệ. ISOLATED: mỗi lệnh cháy riêng ~100/đòn_bẩy%.">
            <select className="input" value={marginMode} onChange={(e) => setMarginMode(e.target.value as any)} disabled={loading}>
              <option value="CROSS">Cross</option>
              <option value="ISOLATED">Isolated</option>
            </select>
          </Field>
        </div>
        <div className="flex flex-wrap gap-4">
          <label className="flex items-center gap-2 text-xs text-gray-300">
            <input type="checkbox" checked={compounding} onChange={(e) => setCompounding(e.target.checked)} disabled={loading} />
            <Tooltip text="BẬT: rủi ro theo số dư hiện tại (lãi kép). TẮT: theo vốn ban đầu cố định — đánh giá edge thật hơn."><span>Tái đầu tư (lãi kép) ⓘ</span></Tooltip>
          </label>
          <label className="flex items-center gap-2 text-xs text-gray-300">
            <input type="checkbox" checked={useRealFunding} onChange={(e) => setUseRealFunding(e.target.checked)} disabled={loading} />
            <Tooltip text="Nạp funding LỊCH SỬ thật từ Binance (cache đĩa) thay ước lượng 0.01%/8h. Chậm hơn lần đầu."><span>Funding thật ⓘ</span></Tooltip>
          </label>
        </div>

        <div className="text-xs text-accent uppercase font-semibold border-t border-border pt-3">🛡 Rủi ro (DD breaker + correlation)</div>

        <label className="flex items-center gap-2 text-xs text-gray-300">
          <input type="checkbox" checked={useDdBreaker} onChange={(e) => setUseDdBreaker(e.target.checked)} disabled={loading} />
          <Tooltip text="Khi drawdown danh mục sâu: giảm size (vùng reduce) rồi NGỪNG mở lệnh mới (vùng halt) tới khi hồi. Kéo MaxDD xuống mạnh nhất.">
            <span>Bật circuit breaker theo drawdown ⓘ</span>
          </Tooltip>
        </label>
        {useDdBreaker && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Field label="DD giảm size (%)" hint="DD ≥ % này → size lệnh mới × hệ số dưới.">
              <select className="input" value={ddReducePct} onChange={(e) => setDdReducePct(Number(e.target.value))} disabled={loading}>
                {[8, 10, 12, 15, 18, 20].map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
            </Field>
            <Field label="Hệ số giảm size">
              <select className="input" value={ddReduceFactor} onChange={(e) => setDdReduceFactor(Number(e.target.value))} disabled={loading}>
                {[0.25, 0.33, 0.5, 0.66, 0.75].map((o) => <option key={o} value={o}>×{o}</option>)}
              </select>
            </Field>
            <Field label="DD ngừng mở (%)" hint="DD ≥ % này → NGỪNG mở lệnh mới cho tới khi hồi về ngưỡng dưới.">
              <select className="input" value={ddHaltPct} onChange={(e) => setDdHaltPct(Number(e.target.value))} disabled={loading}>
                {[15, 18, 20, 25, 30, 40].map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
            </Field>
            <Field label="DD mở lại (%)" hint="Sau khi ngừng, chỉ mở lại khi DD hồi về ≤ % này.">
              <select className="input" value={ddResumePct} onChange={(e) => setDdResumePct(Number(e.target.value))} disabled={loading}>
                {[5, 8, 10, 12, 15].map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
            </Field>
          </div>
        )}

        <label className="flex items-center gap-2 text-xs text-gray-300 border-t border-border pt-3">
          <input type="checkbox" checked={useCorrelationCap} onChange={(e) => setUseCorrelationCap(e.target.checked)} disabled={loading} />
          <Tooltip text="Gom coin tương quan cao (theo return ngày) thành cụm, giới hạn số vị thế mở/cụm — tránh dồn nhiều cược cùng beta BTC.">
            <span>Bật correlation cluster cap ⓘ</span>
          </Tooltip>
        </label>
        {useCorrelationCap && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Field label="Trần vị thế / cụm">
              <select className="input" value={maxPerCluster} onChange={(e) => setMaxPerCluster(Number(e.target.value))} disabled={loading}>
                {[1, 2, 3, 4, 5].map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
            </Field>
            <Field label="Ngưỡng tương quan" hint="Corr ≥ ngưỡng → gom cùng cụm. Cao hơn = ít gom hơn (nhiều cụm nhỏ).">
              <select className="input" value={corrThreshold} onChange={(e) => setCorrThreshold(Number(e.target.value))} disabled={loading}>
                {[0.6, 0.7, 0.75, 0.8, 0.85, 0.9].map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
            </Field>
          </div>
        )}
        <p className="text-[11px] text-gray-500">
          Mục tiêu: kéo <b>Max Drawdown &lt; 20%</b> (theo spec). DD breaker cắt lệnh khi thua sâu; correlation cap ngăn dồn cược cùng hướng thị trường.
        </p>

        <div className="text-xs text-accent uppercase font-semibold border-t border-border pt-3">💸 Chi phí</div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Field label="Phí (%/chiều)">
            <select className="input" value={feePct} onChange={(e) => setFeePct(Number(e.target.value))} disabled={loading}>
              {[0, 0.02, 0.04, 0.045, 0.05, 0.075, 0.1].map((o) => <option key={o} value={o}>{o}%</option>)}
            </select>
          </Field>
          <Field label="Trượt giá (%/chiều)">
            <select className="input" value={slippagePct} onChange={(e) => setSlippagePct(Number(e.target.value))} disabled={loading}>
              {[0, 0.01, 0.02, 0.05, 0.1].map((o) => <option key={o} value={o}>{o}%</option>)}
            </select>
          </Field>
        </div>
        <p className="text-[11px] text-gray-500">Tổng chi phí mỗi lệnh ≈ {(2 * (feePct + slippagePct)).toFixed(3)}% (round-trip) — trừ thẳng vào % lãi/lỗ.</p>

        <div className="border-t border-border pt-3 space-y-2">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs text-gray-400 uppercase font-semibold">Chiến lược:</span>
            <div className="inline-flex rounded-md overflow-hidden border border-border">
              <button
                type="button"
                className={`px-3 py-1 text-xs ${strategyMode === "trend" ? "bg-accent text-black font-semibold" : "bg-panel2 text-gray-300"}`}
                onClick={() => setStrategyMode("trend")}
                disabled={loading}
              >
                Trend
              </button>
              <button
                type="button"
                className={`px-3 py-1 text-xs ${strategyMode === "router" ? "bg-accent text-black font-semibold" : "bg-panel2 text-gray-300"}`}
                onClick={() => setStrategyMode("router")}
                disabled={loading}
              >
                Router (Trend + MeanRev)
              </button>
            </div>
          </div>
          {strategyMode === "router" && (
            <p className="text-[11px] text-amber-500">
              ⚠ Router thêm nhánh mean-reversion (fade khi thị trường RANGE). Kiểm nghiệm trên rổ 8 coin large-cap:
              mean-rev <b>không cải thiện</b> PF/DD (trend-only vẫn tốt hơn). Dùng để tự đối chứng / thử universe khác.
            </p>
          )}
          <div className="flex items-center gap-3 flex-wrap">
            <button className="btn btn-primary" onClick={runBacktest} disabled={loading || tp.emaFast >= tp.emaSlow}>
              {loading
                ? "Đang chạy..."
                : `🧪 Backtest ${strategyMode === "router" ? "Router" : "Trend"} → ${interval} · DC${tp.dcEntry}/${tp.dcExit} · ${allowLong ? "L" : ""}${allowShort ? "S" : ""}${useRegime ? " · regime" : ""}`}
            </button>
            {error && <span className="text-down text-sm">{error}</span>}
          </div>
        </div>

        {progress && (
          <div className="space-y-1">
            <div className="flex justify-between text-xs text-gray-400">
              <span>{progress.done}/{progress.total || "?"} symbol{progress.symbol ? ` · ${progress.symbol}` : ""}</span>
              <span>{progress.total ? Math.round((progress.done / progress.total) * 100) : 0}%</span>
            </div>
            <div className="w-full h-2 bg-panel2 rounded overflow-hidden">
              <div className="h-full bg-accent transition-all" style={{ width: `${progress.total ? (progress.done / progress.total) * 100 : 0}%` }} />
            </div>
          </div>
        )}
      </div>

      {result && (
        <>
          <div className="card flex items-center justify-between gap-2 flex-wrap py-2">
            <span className="text-sm text-gray-300">
              Kết quả: <b>{result.totalTrades}</b> lệnh · Win <b>{result.winRate.toFixed(1)}%</b> · ROI{" "}
              <b className={result.roiPct >= 0 ? "text-up" : "text-down"}>{result.roiPct >= 0 ? "+" : ""}{result.roiPct}%</b>
              {" · "}MaxDD <b className="text-down">{result.maxDrawdownPct}%</b>
              {" · "}expR <b className={result.expectancyR >= 0 ? "text-up" : "text-down"}>{result.expectancyR}</b>
            </span>
            <button className="btn btn-primary" onClick={saveResult} disabled={saving || !runParams}>
              {saving ? "Đang lưu..." : "💾 Lưu lịch sử"}
            </button>
          </div>
          <BacktestResults result={result} emptyHint="Không có tín hiệu breakout thỏa điều kiện trong khoảng này — thử nới ADX/ATR%, tăng dcEntry, hoặc tắt regime." />
        </>
      )}

      <SavedBacktestHistory refreshKey={historyKey} strategy="TREND" onOpen={openRecord} />
    </div>
  );
}
