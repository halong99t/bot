import { useState, useEffect, type ReactNode } from "react";
import { toast } from "sonner";
import { api } from "../api/client";
import Tooltip from "../components/Tooltip";
import BacktestResults from "../components/BacktestResults";
import TimeRangePicker from "../components/TimeRangePicker";
import SavedBacktestHistory from "../components/SavedBacktestHistory";
import type { BacktestResult, EmaClassifyResponse, BacktestHistoryItem } from "../types";

const TIMEFRAMES = ["15m", "1h", "4h", "1d"] as const;
type Timeframe = (typeof TIMEFRAMES)[number];

type StateKey = "LONG1" | "LONG2" | "LONG3" | "SHORT3" | "SHORT2" | "SHORT1";

// Bảng 6 trạng thái — Spec v1.0.0
const STATES: {
  order: string;
  state: StateKey;
  bias: "LONG" | "SHORT";
  structure: string;
  alignment: string;
  risk: string;
  desc: string;
}[] = [
  { order: "P > F > S", state: "LONG1", bias: "LONG", structure: "BULL", alignment: "MOMENTUM", risk: "low", desc: "Giá trên cả hai, cấu trúc tăng — momentum tăng mạnh" },
  { order: "F > P > S", state: "LONG2", bias: "LONG", structure: "BULL", alignment: "PULLBACK", risk: "medium", desc: "Giá kẹp giữa — pullback trong uptrend" },
  { order: "F > S > P", state: "LONG3", bias: "LONG", structure: "BULL", alignment: "REVERSAL", risk: "high", desc: "Giá dưới cả hai, cấu trúc vẫn tăng — bắt đáy ngược cấu trúc" },
  { order: "P > S > F", state: "SHORT3", bias: "SHORT", structure: "BEAR", alignment: "REVERSAL", risk: "high", desc: "Giá trên cả hai, cấu trúc giảm — bắt đỉnh ngược cấu trúc" },
  { order: "S > P > F", state: "SHORT2", bias: "SHORT", structure: "BEAR", alignment: "PULLBACK", risk: "medium", desc: "Giá kẹp giữa — hồi lên trong downtrend" },
  { order: "S > F > P", state: "SHORT1", bias: "SHORT", structure: "BEAR", alignment: "MOMENTUM", risk: "low", desc: "Giá dưới cả hai, cấu trúc giảm — momentum giảm mạnh" },
];

// Chỉ dùng state momentum (1) để vào lệnh — bỏ 2/3 (pullback/reversal) vì gây whipsaw, hiệu quả kém.
const ALL_STATES: StateKey[] = ["LONG1", "SHORT1"];

const riskColor = (risk: string) =>
  risk === "low" ? "text-up" : risk === "medium" ? "text-accent" : risk === "high" ? "text-down" : "text-gray-400";

function StateBadge({ state, bias }: { state: string; bias: string }) {
  const cls =
    bias === "LONG"
      ? "bg-up/20 text-up"
      : bias === "SHORT"
      ? "bg-down/20 text-down"
      : "bg-panel2 text-gray-300";
  return <span className={`px-2 py-0.5 rounded text-xs font-semibold ${cls}`}>{state}</span>;
}

const fmtDT = (ts: number) =>
  `${new Date(ts).toLocaleDateString()} ${new Date(ts).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  })}`;

// Thứ tự 3 giá trị giảm dần -> "P > F > S"
const orderString = (P: number, F: number | null, S: number | null) => {
  if (F == null || S == null) return "—";
  return ([["P", P], ["F", F], ["S", S]] as [string, number][])
    .sort((a, b) => b[1] - a[1])
    .map((x) => x[0])
    .join(" > ");
};

// Nhóm chọn nhanh state vào lệnh
const STATE_GROUPS: { label: string; states: StateKey[] }[] = [
  { label: "Cả LONG + SHORT", states: ["LONG1", "SHORT1"] },
  { label: "Chỉ LONG", states: ["LONG1"] },
  { label: "Chỉ SHORT", states: ["SHORT1"] },
];
const STATE_ALIGN_SHORT: Record<StateKey, string> = {
  LONG1: "Mom",
  LONG2: "Pull",
  LONG3: "Rev",
  SHORT1: "Mom",
  SHORT2: "Pull",
  SHORT3: "Rev",
};

// Ô nhập có nhãn (gọn lặp code)
function Field({
  label,
  hint,
  children,
  className,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
  className?: string;
}) {
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

// Nút chọn dạng segmented
function Seg({
  active,
  onClick,
  disabled,
  children,
}: {
  active: boolean;
  onClick: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <button onClick={onClick} disabled={disabled} className={`btn ${active ? "btn-primary" : "btn-ghost"}`}>
      {children}
    </button>
  );
}

// Bộ tham số gợi ý (rút ra từ grid search + tối ưu exit T1-T6/2026) — bấm để nạp nhanh vào form.
// Đã tối ưu chiến thuật thoát lệnh: neo SL + luôn bật đóng-khi-lật-bias.
const PRESETS: {
  name: string;
  desc: string;
  interval: Timeframe; // khung nến bộ gợi ý này dành cho — dùng để lọc theo khung đang chọn
  fast: number;
  slow: number;
  eps: number;
  states: StateKey[];
  slAnchor: "atr" | "structure" | "protective";
  slAtrMult: number;
  lev: number;
  mm: "CROSS" | "ISOLATED";
  risk: number;
  cap: number; // trần rủi ro danh mục (%) — 0 = không giới hạn
}[] = [
  { name: "🎯 Chủ lực · risk 1%", desc: "30/60 · eps3 · SL atr×3.5 · 20× · Cross · risk 1% — +46.9%, DD 7%, 5/6 tháng (an toàn, mặc định)", interval: "1h", fast: 30, slow: 60, eps: 3, states: ["LONG1", "SHORT1"], slAnchor: "atr", slAtrMult: 3.5, lev: 20, mm: "CROSS", risk: 1, cap: 0 },
  { name: "🔥 Chủ lực · risk 10% (trần 30%)", desc: "risk 10%/lệnh · trần rủi ro DM 30% (≤3 lệnh đồng thời) — ROI ~+162%, DD ~73% (nặng tay, đã chặn dồn lệnh)", interval: "1h", fast: 30, slow: 60, eps: 3, states: ["LONG1", "SHORT1"], slAnchor: "atr", slAtrMult: 3.5, lev: 20, mm: "CROSS", risk: 10, cap: 30 },
  // ----- Top 3 bộ gợi ý cho khung 15m (grid 28 tổ hợp + test TÁCH TỪNG THÁNG, toàn sàn 503 coin, 2026 H1, risk 1% · trần 20% · Cross) -----
  // ⚠ 15m KHÔNG chạy liền 6 tháng — nên test theo cửa sổ ngắn (≤1 tháng). Tháng 4/2026 âm với mọi bộ; hầu hết bộ lãi 2-4/6 tháng.
  { name: "🥇 15m · EMA 12/26 (ổn định)", desc: "12/26 · eps2.5 · SL atr×4.5 · 20× · Cross · risk 1% · trần 20% — ỔN ĐỊNH NHẤT: ROI TB +0.2%/tháng, DD tháng ≤10.9%, chịu tháng xấu tốt nhất (T4 chỉ −4.9%). Test tách tháng H1/2026.", interval: "15m", fast: 12, slow: 26, eps: 2.5, states: ["LONG1", "SHORT1"], slAnchor: "atr", slAtrMult: 4.5, lev: 20, mm: "CROSS", risk: 1, cap: 20 },
  { name: "🥈 15m · EMA 9/21 (nhiều tháng lãi)", desc: "9/21 · eps2.5 · SL atr×3.5 · 20× · Cross · risk 1% · trần 20% — LÃI 4/6 THÁNG (Jan +6.7 · Feb +2.5 · Mar +1.2 · Jun +1.0) nhưng T4 −13%. Nên né/giảm size tháng xấu. Test tách tháng H1/2026.", interval: "15m", fast: 9, slow: 21, eps: 2.5, states: ["LONG1", "SHORT1"], slAnchor: "atr", slAtrMult: 3.5, lev: 20, mm: "CROSS", risk: 1, cap: 20 },
  { name: "🥉 15m · EMA 20/50 (trend/bùng nổ)", desc: "20/50 · eps3.5 · SL atr×3.5 · 20× · Cross · risk 1% · trần 20% — BÙNG NỔ tháng trend mạnh (Jan +19.9%, win 61%) nhưng các tháng khác âm. Chỉ bật khi xu hướng rõ. Test tách tháng H1/2026.", interval: "15m", fast: 20, slow: 50, eps: 3.5, states: ["LONG1", "SHORT1"], slAnchor: "atr", slAtrMult: 3.5, lev: 20, mm: "CROSS", risk: 1, cap: 20 },
];

// Top 10 coin vốn hóa cao nhất (USDT-perp) — để test nhanh trên rổ blue-chip, tránh alt rác dễ bị squeeze.
const TOP10_MCAP = ["BTCUSDT", "ETHUSDT", "BNBUSDT", "SOLUSDT", "XRPUSDT", "DOGEUSDT", "ADAUSDT", "TRXUSDT", "AVAXUSDT", "LINKUSDT"];

export default function EmaClassifier() {
  // ---- Cấu hình chung EMA ----
  const [interval, setInterval_] = useState<Timeframe>("1h");
  const [fast, setFast] = useState(30);
  const [slow, setSlow] = useState(60);
  const [epsilonMode, setEpsilonMode] = useState<"atr" | "percent" | "absolute">("atr");
  // Mặc định = bộ "Chủ lực" (eps3): lọc crossover nhiễu, win% cao, drawdown thấp (grid search T1-T6/2026)
  const [epsilonValue, setEpsilonValue] = useState(3);
  const [atrPeriod, setAtrPeriod] = useState(14);

  // ---- Phân loại LIVE ----
  const [liveSymbol, setLiveSymbol] = useState("BTCUSDT");
  const [live, setLive] = useState<EmaClassifyResponse | null>(null);
  const [liveLoading, setLiveLoading] = useState(false);
  const [liveErr, setLiveErr] = useState<string | null>(null);

  const classifyLive = async () => {
    setLiveLoading(true);
    setLiveErr(null);
    try {
      const r = await api.classifyEma({
        symbol: liveSymbol.trim().toUpperCase(),
        interval,
        fast,
        slow,
        epsilonMode,
        epsilonValue,
        atrPeriod,
      });
      setLive(r);
    } catch (e: any) {
      setLiveErr(e?.response?.data?.message ?? e?.message ?? "Không phân loại được");
    } finally {
      setLiveLoading(false);
    }
  };

  // ---- Backtest ----
  const [marginMode, setMarginMode] = useState<"CROSS" | "ISOLATED">("CROSS");
  const [tpSlMode, setTpSlMode] = useState<"PRICE" | "MARGIN">("MARGIN");
  const [sizeMode, setSizeMode] = useState<"percent" | "fixed">("percent");
  const [entryStates, setEntryStates] = useState<StateKey[]>(["LONG1", "SHORT1"]);
  // Chiến thuật thoát lệnh: simple = TP/SL % cố định | alignment = chiến thuật v1.1 theo alignment
  const [exitStrategy, setExitStrategy] = useState<"simple" | "alignment">("alignment");
  const [slAnchor, setSlAnchor] = useState<"atr" | "structure" | "protective">("atr");
  const [globalOverlay, setGlobalOverlay] = useState(true);
  const [hardExit, setHardExit] = useState(true);
  // Đòn bẩy cho chế độ alignment: 1 = không thanh lý (như đã kiểm chứng); >1 = mô phỏng cháy khi giá đi ngược ~100/đòn_bẩy%
  const [alignLeverage, setAlignLeverage] = useState(20);
  const [riskCompound, setRiskCompound] = useState(true); // lãi kép theo số dư (true) hay vốn cố định (false)
  // Chi phí giao dịch & trần rủi ro danh mục (chống "ăn tỷ đô" ảo)
  const [feePct, setFeePct] = useState(0.05);
  const [slippagePct, setSlippagePct] = useState(0.02);
  const [maxPortfolioRiskPct, setMaxPortfolioRiskPct] = useState(0); // 0 = không giới hạn
  const [align, setAlign] = useState({
    riskPerTradePct: 1,
    swingLookback: 10,
    emaBufferAtr: 0.25,
    slAtrMult: 3.5,
  });
  const setA = (k: keyof typeof align, v: string) => setAlign((a) => ({ ...a, [k]: Number(v) }));
  const [localCount, setLocalCount] = useState<number | null>(null);
  const [localSymbols, setLocalSymbols] = useState("");
  const [cacheInfo, setCacheInfo] = useState<{ cached: number; total: number; building: boolean } | null>(null);
  const [rangeMode, setRangeMode] = useState<"recent" | "year" | "custom">("recent");
  const [year, setYear] = useState(2026);
  const [monthsSel, setMonthsSel] = useState<number[]>([3]);
  const [yearsSel, setYearsSel] = useState<number[]>([]);
  // Cửa sổ ngắn cho 15m: khoảng NGÀY trong 1 tháng (tối đa 1 tháng)
  const [dayFrom, setDayFrom] = useState(1);
  const [dayTo, setDayTo] = useState(31);
  const [dataRange, setDataRange] = useState<{ minTs: number; maxTs: number } | null>(null);
  const granular = interval === "15m"; // 15m -> ẩn năm/khoảng, chỉ tháng + ngày
  const [form, setForm] = useState({
    months: 3,
    takeProfitPct: 90,
    stopLossPct: 50,
    initialCapitalUsdt: 1000,
    orderSizeUsdt: 50,
    positionSizePct: 5,
    leverage: 5,
    maxConcurrentPositions: 50,
  });
  const [result, setResult] = useState<BacktestResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number; symbol?: string } | null>(null);
  // Bộ thông số đúng như lúc chạy (để lưu lịch sử chính xác dù form đổi sau đó)
  const [runParams, setRunParams] = useState<Record<string, unknown> | null>(null);
  const [saving, setSaving] = useState(false);
  const [historyKey, setHistoryKey] = useState(0);

  const setF = (k: keyof typeof form, v: string) => setForm((f) => ({ ...f, [k]: Number(v) }));
  const toggleState = (s: StateKey) =>
    setEntryStates((cur) => (cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s]));
  const sameStates = (a: StateKey[]) =>
    a.length === entryStates.length && a.every((s) => entryStates.includes(s));

  useEffect(() => {
    api.getLocalSymbols().then((d) => setLocalCount(d.count)).catch(() => setLocalCount(0));
    api
      .getLocalRange()
      .then((r) => {
        if (r.maxTs > 0) {
          setDataRange(r);
          const maxD = new Date(r.maxTs);
          setYear(maxD.getUTCFullYear());
          setMonthsSel([maxD.getUTCMonth() + 1]);
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

  // Khi chuyển sang 15m: bật cửa sổ ngắn — chọn đúng 1 tháng (mới nhất có data) + cả tháng
  useEffect(() => {
    if (interval !== "15m") return;
    setRangeMode("custom");
    setMonthsSel((cur) => {
      if (cur.length === 1) return cur; // giữ nếu đã là 1 tháng
      const base = dataRange ? new Date(dataRange.maxTs) : new Date(year, 0, 1);
      const m = dataRange ? base.getUTCMonth() + 1 : (cur[0] ?? 1);
      const nd = new Date(year, m, 0).getDate();
      setDayFrom(1);
      setDayTo(nd);
      return [m];
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [interval]);

  const availYears = (() => {
    if (!dataRange) return [2021, 2022, 2023, 2024, 2025, 2026];
    const a = new Date(dataRange.minTs).getUTCFullYear();
    const b = new Date(dataRange.maxTs).getUTCFullYear();
    const out: number[] = [];
    for (let y = a; y <= b; y++) out.push(y);
    return out;
  })();
  const availMonths = (() => {
    if (!dataRange) return [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
    const minD = new Date(dataRange.minTs);
    const maxD = new Date(dataRange.maxTs);
    const start = year === minD.getUTCFullYear() ? minD.getUTCMonth() + 1 : 1;
    const end = year === maxD.getUTCFullYear() ? maxD.getUTCMonth() + 1 : 12;
    const out: number[] = [];
    for (let m = start; m <= end; m++) out.push(m);
    return out;
  })();

  const runBacktest = async () => {
    if (fast >= slow) {
      toast.error("EMA Fast phải nhỏ hơn EMA Slow");
      return;
    }
    if (!entryStates.length) {
      toast.error("Chọn ít nhất 1 state vào lệnh");
      return;
    }
    let fromMs: number | undefined;
    let toMs: number | undefined;
    if (granular) {
      // 15m: cửa sổ ngắn = 1 tháng + khoảng ngày (tối đa 1 tháng)
      const m = monthsSel[0];
      if (!m) {
        toast.error("Hãy chọn 1 tháng");
        return;
      }
      const nd = new Date(year, m, 0).getDate();
      const dF = Math.min(Math.max(dayFrom, 1), nd);
      const dT = Math.min(Math.max(dayTo, dF), nd);
      fromMs = new Date(year, m - 1, dF).getTime();
      toMs = new Date(year, m - 1, dT + 1).getTime(); // hết ngày dT
    } else if (rangeMode === "custom") {
      if (!monthsSel.length) {
        toast.error("Hãy chọn ít nhất 1 tháng");
        return;
      }
      const sorted = [...monthsSel].sort((a, b) => a - b);
      fromMs = new Date(year, sorted[0] - 1, 1).getTime();
      toMs = new Date(year, sorted[sorted.length - 1], 1).getTime();
    } else if (rangeMode === "year") {
      if (!yearsSel.length) {
        toast.error("Hãy chọn ít nhất 1 năm");
        return;
      }
      const ys = [...yearsSel].sort((a, b) => a - b);
      fromMs = new Date(ys[0], 0, 1).getTime();
      toMs = new Date(ys[ys.length - 1] + 1, 0, 1).getTime(); // hết năm lớn nhất
    } else {
      toMs = Date.now();
      fromMs = toMs - form.months * 30 * 24 * 60 * 60 * 1000;
    }
    const symbols = localSymbols
      .split(/[\s,]+/)
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean);

    setLoading(true);
    setError(null);
    setResult(null);
    setProgress({ done: 0, total: 0 });
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const base: Record<string, unknown> = {
      interval,
      fastPeriod: fast,
      slowPeriod: slow,
      epsilonMode,
      epsilonValue,
      atrPeriod,
      entryStates,
      fromMs,
      toMs,
      initialCapitalUsdt: form.initialCapitalUsdt,
      maxConcurrentPositions: form.maxConcurrentPositions,
      feePct,
      slippagePct,
      monthlyReset: false,
      symbols: symbols.length ? symbols : undefined,
    };
    const body =
      exitStrategy === "alignment"
        ? {
            ...base,
            exitStrategy: "alignment",
            riskPerTradePct: align.riskPerTradePct,
            riskCompound,
            maxPortfolioRiskPct,
            swingLookback: align.swingLookback,
            emaBufferAtr: align.emaBufferAtr,
            slAnchor,
            slAtrMult: align.slAtrMult,
            globalExitOverlay: globalOverlay,
            hardExit,
            leverage: alignLeverage,
            marginMode,
          }
        : {
            ...base,
            exitStrategy: "simple",
            takeProfitPct: form.takeProfitPct,
            stopLossPct: form.stopLossPct,
            orderSizeUsdt: form.orderSizeUsdt,
            positionSizePct: sizeMode === "percent" ? form.positionSizePct : 0,
            leverage: form.leverage,
            marginMode,
            tpSlMode,
          };
    try {
      const { jobId, total } = await api.runEmaBacktest(body);
      setProgress({ done: 0, total });
      for (let i = 0; i < 6000; i++) {
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
      setError(e?.response?.data?.message ?? e?.message ?? "Backtest EMA thất bại");
    } finally {
      setLoading(false);
      setProgress(null);
    }
  };

  // Bộ gợi ý đang khớp với form (để hiện mô tả) — phân biệt theo risk giữa 2 bộ
  const selectedPreset = PRESETS.find(
    (p) =>
      p.interval === interval &&
      fast === p.fast &&
      slow === p.slow &&
      epsilonValue === p.eps &&
      align.riskPerTradePct === p.risk &&
      entryStates.length === p.states.length &&
      p.states.every((s) => entryStates.includes(s))
  );

  // Nạp nhanh 1 bộ tham số gợi ý vào form backtest (gồm cả exit đã tối ưu)
  const applyPreset = (p: (typeof PRESETS)[number]) => {
    setInterval_(p.interval);
    setFast(p.fast);
    setSlow(p.slow);
    setEpsilonMode("atr");
    setEpsilonValue(p.eps);
    setEntryStates(p.states);
    setExitStrategy("alignment");
    setSlAnchor(p.slAnchor);
    setAlign((a) => ({ ...a, slAtrMult: p.slAtrMult, riskPerTradePct: p.risk }));
    setMaxPortfolioRiskPct(p.cap);
    setGlobalOverlay(true); // luôn đóng khi lật bias
    setHardExit(true);
    setAlignLeverage(p.lev);
    setMarginMode(p.mm);
    toast.success(`Đã nạp bộ "${p.name.replace(/^[^ ]+ /, "")}" (exit + đòn bẩy tối ưu) — bấm Backtest để chạy`);
  };

  // Lưu kết quả EMA vào DB (upsert theo thông số + khung + năm)
  const saveResult = async () => {
    if (!result || !runParams) return;
    setSaving(true);
    try {
      const { count } = await api.saveBacktestHistory({
        params: runParams,
        interval: (runParams.interval as string) ?? interval,
        strategy: "EMA",
        result,
      });
      toast.success(`Đã lưu lịch sử EMA [${runParams.interval ?? interval}] — tách ${count} tháng`);
      setHistoryKey((k) => k + 1);
    } catch (e: any) {
      toast.error(e?.response?.data?.message ?? "Lưu lịch sử thất bại");
    } finally {
      setSaving(false);
    }
  };

  // Mở lại 1 bản ghi -> nạp result vào khu vực xem kết quả
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
        <h2 className="text-xl font-bold">EMA / Entry Position Classifier</h2>
        <p className="text-xs text-gray-400 mt-1 max-w-3xl">
          Phân loại vị thế giá (P) so với EMA Fast (F) &amp; EMA Slow (S) thành 6 trạng thái LONG/SHORT
          (sắp 3 giá trị giảm dần → tra bảng). Vùng giao cắt |F−S| &lt; ε → NEUTRAL; chưa đủ warmup →
          UNKNOWN. Toàn bộ chạy trên dữ liệu 1m local.
        </p>
      </div>

      {/* ===== Cấu hình EMA & epsilon (dùng chung) ===== */}
      <div className="card space-y-3">
        <div className="flex items-center gap-2">
          <span className="text-xs text-accent uppercase font-semibold">⚙ Cấu hình EMA &amp; epsilon</span>
          {fast >= slow && <span className="text-down text-xs">⚠ Fast phải nhỏ hơn Slow</span>}
        </div>
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
          <Field label="Khung nến">
            <select className="input" value={interval} onChange={(e) => setInterval_(e.target.value as Timeframe)} disabled={loading}>
              {TIMEFRAMES.map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
          </Field>
          <Field label="EMA Fast">
            <input type="number" className="input" value={fast} onChange={(e) => setFast(Number(e.target.value))} />
          </Field>
          <Field label="EMA Slow">
            <input type="number" className="input" value={slow} onChange={(e) => setSlow(Number(e.target.value))} />
          </Field>
          <Field label="Epsilon mode" hint="Vùng coi như NEUTRAL quanh giao cắt. atr: ε = value × ATR. percent: % của giá. absolute: đơn vị giá.">
            <select className="input" value={epsilonMode} onChange={(e) => setEpsilonMode(e.target.value as any)} disabled={loading}>
              <option value="atr">atr</option>
              <option value="percent">percent</option>
              <option value="absolute">absolute</option>
            </select>
          </Field>
          <Field label="Epsilon value">
            <input type="number" step="0.01" className="input" value={epsilonValue} onChange={(e) => setEpsilonValue(Number(e.target.value))} />
          </Field>
          <Field label="ATR period">
            <input type="number" className="input" value={atrPeriod} onChange={(e) => setAtrPeriod(Number(e.target.value))} />
          </Field>
        </div>
      </div>

      {/* ===== Phân loại mới nhất (hero) ===== */}
      <div className="card space-y-3">
        <div className="flex items-end gap-2 flex-wrap">
          <span className="text-xs text-accent uppercase font-semibold mr-auto">📡 Phân loại mới nhất (1m local)</span>
          <Field label="Symbol" className="w-44">
            <input
              className="input"
              value={liveSymbol}
              onChange={(e) => setLiveSymbol(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") classifyLive();
              }}
              placeholder="VD: 0GUSDT"
            />
          </Field>
          <button className="btn btn-primary" onClick={classifyLive} disabled={liveLoading || fast >= slow}>
            {liveLoading ? "Đang phân loại..." : "Phân loại"}
          </button>
        </div>
        {liveErr && <p className="text-down text-sm">{liveErr}</p>}

        {live?.current &&
          (() => {
            const cur = live.current;
            const meaning = STATES.find((x) => x.state === cur.state)?.desc;
            const heroCls =
              cur.bias === "LONG"
                ? "bg-up/10 border-up/40"
                : cur.bias === "SHORT"
                ? "bg-down/10 border-down/40"
                : "bg-panel2 border-border";
            return (
              <div className="grid md:grid-cols-[200px_1fr] gap-4 items-stretch">
                <div className={`rounded-lg border p-4 flex flex-col items-center justify-center text-center ${heroCls}`}>
                  <StateBadge state={cur.state} bias={cur.bias} />
                  <div className="font-mono text-lg font-bold mt-2">{orderString(cur.close, cur.fast, cur.slow)}</div>
                  <div className="text-xs text-gray-400 mt-1">
                    {cur.alignment !== "NONE" ? cur.alignment : "—"}
                    {cur.risk !== "none" ? (
                      <>
                        {" · risk "}
                        <span className={riskColor(cur.risk)}>{cur.risk}</span>
                      </>
                    ) : null}
                  </div>
                  {cur.is_signal && <div className="text-[11px] text-accent mt-1">● tín hiệu mới (đổi state)</div>}
                </div>
                <div className="space-y-2">
                  <div className="text-sm">
                    <b>{live.symbol}</b> · {live.interval} · EMA {live.fastPeriod}/{live.slowPeriod} ·{" "}
                    {fmtDT(new Date(cur.timestamp).getTime())}
                  </div>
                  <div className="grid grid-cols-3 gap-2">
                    <div className="card py-2">
                      <div className="text-[11px] text-gray-400 uppercase">P (close)</div>
                      <div className="font-semibold">{cur.close}</div>
                    </div>
                    <div className="card py-2">
                      <div className="text-[11px] text-gray-400 uppercase">EMA Fast</div>
                      <div className="font-semibold">{cur.fast?.toFixed(4) ?? "—"}</div>
                    </div>
                    <div className="card py-2">
                      <div className="text-[11px] text-gray-400 uppercase">EMA Slow</div>
                      <div className="font-semibold">{cur.slow?.toFixed(4) ?? "—"}</div>
                    </div>
                  </div>
                  {meaning && <p className="text-xs text-gray-400">{meaning}</p>}
                </div>
              </div>
            );
          })()}

        {live?.recent?.length ? (
          <details className="text-sm">
            <summary className="cursor-pointer text-gray-400 hover:text-gray-200 select-none">20 nến gần nhất</summary>
            <div className="overflow-x-auto mt-2">
              <table className="resp-table w-full min-w-[640px]">
                <thead>
                  <tr>
                    <th className="th">Thời gian</th>
                    <th className="th">Close</th>
                    <th className="th">EMA Fast</th>
                    <th className="th">EMA Slow</th>
                    <th className="th">State</th>
                    <th className="th">Alignment</th>
                    <th className="th">Signal</th>
                  </tr>
                </thead>
                <tbody>
                  {[...live.recent].reverse().map((c, i) => (
                    <tr key={i} className="hover:bg-panel2">
                      <td className="td text-xs text-gray-300 whitespace-nowrap" data-label="Thời gian">{fmtDT(new Date(c.timestamp).getTime())}</td>
                      <td className="td text-xs" data-label="Close">{c.close}</td>
                      <td className="td text-xs" data-label="EMA Fast">{c.fast?.toFixed(4) ?? "—"}</td>
                      <td className="td text-xs" data-label="EMA Slow">{c.slow?.toFixed(4) ?? "—"}</td>
                      <td className="td" data-label="State"><StateBadge state={c.state} bias={c.bias} /></td>
                      <td className="td text-xs text-gray-400" data-label="Alignment">{c.alignment !== "NONE" ? c.alignment : ""}</td>
                      <td className="td text-xs" data-label="Signal">{c.is_signal ? "●" : ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        ) : null}
      </div>

      {/* ===== Bảng tra 6 trạng thái (tham chiếu, thu gọn) ===== */}
      <details className="card p-0">
        <summary className="px-3 py-2 font-semibold cursor-pointer select-none">📖 Bảng tra 6 trạng thái (tham chiếu)</summary>
        <div className="overflow-x-auto border-t border-border">
          <table className="resp-table w-full min-w-[720px]">
            <thead>
              <tr>
                <th className="th">Thứ tự (cao→thấp)</th>
                <th className="th">State</th>
                <th className="th">Bias</th>
                <th className="th">Structure</th>
                <th className="th">Alignment</th>
                <th className="th">Risk</th>
                <th className="th">Ý nghĩa</th>
              </tr>
            </thead>
            <tbody>
              {STATES.map((s) => (
                <tr key={s.state} className="hover:bg-panel2">
                  <td className="td font-mono text-xs" data-label="Thứ tự">{s.order}</td>
                  <td className="td" data-label="State"><StateBadge state={s.state} bias={s.bias} /></td>
                  <td className={`td ${s.bias === "LONG" ? "text-up" : "text-down"}`} data-label="Bias">{s.bias}</td>
                  <td className="td text-gray-300" data-label="Structure">{s.structure}</td>
                  <td className="td text-gray-300" data-label="Alignment">{s.alignment}</td>
                  <td className={`td font-medium ${riskColor(s.risk)}`} data-label="Risk">{s.risk}</td>
                  <td className="td text-xs text-gray-400" data-label="Ý nghĩa">{s.desc}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="px-3 py-2 text-[11px] text-gray-500">
            MOMENTUM = giá đồng pha cấu trúc (tín hiệu sạch). REVERSAL (LONG3/SHORT3) là counter-trend — rủi ro cao.
          </p>
        </div>
      </details>

      {/* ===== Backtest ===== */}
      <div className="card space-y-4">
        <div className="text-xs text-accent uppercase font-semibold">🧪 Backtest theo EMA classifier (1m local)</div>

        {/* Bộ tham số gợi ý (từ grid search) — LỌC THEO KHUNG đang chọn (15m chỉ hiện bộ 15m, ẩn 1h; và ngược lại) */}
        <div>
          <div className="text-[11px] text-gray-400 uppercase mb-1">
            ⭐ Bộ gợi ý cho khung <span className="text-accent">{interval}</span> (từ grid search)
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <select
              className="input w-auto min-w-[16rem]"
              value=""
              onChange={(e) => {
                const p = PRESETS[Number(e.target.value)];
                if (p) applyPreset(p);
              }}
              disabled={loading || !PRESETS.some((p) => p.interval === interval)}
            >
              <option value="">— Chọn bộ gợi ý để nạp —</option>
              {PRESETS.map((p, i) => ({ p, i }))
                .filter(({ p }) => p.interval === interval)
                .map(({ p, i }) => (
                  <option key={p.name} value={i}>{p.name}</option>
                ))}
            </select>
            {selectedPreset && (
              <span className="text-[11px] text-gray-400">{selectedPreset.desc}</span>
            )}
            {!PRESETS.some((p) => p.interval === interval) && (
              <span className="text-[11px] text-gray-500">Chưa có bộ gợi ý cho khung {interval} — chỉnh tay bên dưới.</span>
            )}
          </div>
        </div>

        {/* State vào lệnh */}
        <div>
          <div className="flex items-center justify-between flex-wrap gap-2">
            <label className="text-xs text-gray-400 uppercase">State phát tín hiệu vào lệnh</label>
            <div className="flex gap-1 flex-wrap">
              {STATE_GROUPS.map((g) => (
                <button
                  key={g.label}
                  onClick={() => setEntryStates(g.states)}
                  disabled={loading}
                  className={`btn px-2 py-0.5 text-xs ${sameStates(g.states) ? "btn-primary" : "btn-ghost"}`}
                >
                  {g.label}
                </button>
              ))}
            </div>
          </div>
          <div className="mt-2 space-y-1.5">
            {(["LONG", "SHORT"] as const).map((side) => (
              <div key={side} className="flex items-center gap-2 flex-wrap">
                <span className={`text-xs font-semibold w-12 ${side === "LONG" ? "text-up" : "text-down"}`}>{side}</span>
                {ALL_STATES.filter((s) => s.startsWith(side)).map((s) => (
                  <button
                    key={s}
                    onClick={() => toggleState(s)}
                    disabled={loading}
                    className={`btn px-2.5 ${entryStates.includes(s) ? "btn-primary" : "btn-ghost"}`}
                  >
                    {entryStates.includes(s) ? "✓ " : ""}
                    {s}
                    <span className="text-[10px] text-gray-400 ml-1">{STATE_ALIGN_SHORT[s]}</span>
                  </button>
                ))}
              </div>
            ))}
          </div>
          <p className="text-[11px] text-gray-500 mt-1">
            Chiều lệnh = bias của state. Vào lệnh khi state ĐỔI sang state được chọn.
          </p>
        </div>

        {/* Symbol + thời gian */}
        <div className="grid md:grid-cols-2 gap-4">
          <Field label={`Lọc symbol (trống = TẤT CẢ ${localCount ?? "?"} coin)`}>
            <input
              className="input"
              placeholder="VD: 0GUSDT, 1000PEPEUSDT"
              value={localSymbols}
              onChange={(e) => setLocalSymbols(e.target.value)}
              disabled={loading}
            />
            <div className="flex gap-2 flex-wrap mt-1">
              <button
                type="button"
                className="btn btn-ghost text-xs py-0.5 px-2"
                onClick={() => setLocalSymbols(TOP10_MCAP.join(", "))}
                disabled={loading}
                title="Nạp 10 coin vốn hóa cao nhất (blue-chip) để test nhanh, tránh alt rác"
              >
                🏆 Top 10 vốn hóa
              </button>
              {localSymbols && (
                <button
                  type="button"
                  className="btn btn-ghost text-xs py-0.5 px-2"
                  onClick={() => setLocalSymbols("")}
                  disabled={loading}
                >
                  ✕ Xóa (tất cả coin)
                </button>
              )}
            </div>
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
            months={form.months}
            setMonths={(n) => setForm((f) => ({ ...f, months: n }))}
            year={year}
            setYear={setYear}
            monthsSel={monthsSel}
            setMonthsSel={setMonthsSel}
            yearsSel={yearsSel}
            setYearsSel={setYearsSel}
            dataRange={dataRange}
            clampToData
            disabled={loading}
            granular={granular}
            dayFrom={dayFrom}
            dayTo={dayTo}
            setDayFrom={setDayFrom}
            setDayTo={setDayTo}
          />
        </div>

        {/* Chiến thuật thoát lệnh — xếp dọc */}
        <div>
          <div className="text-xs text-accent uppercase font-semibold mb-2">🎯 Chiến thuật thoát lệnh (TP/SL)</div>
          <div className="space-y-2">
            <button
              onClick={() => setExitStrategy("alignment")}
              disabled={loading}
              className={`w-full text-left rounded-lg border p-3 transition-colors ${
                exitStrategy === "alignment" ? "border-accent bg-panel2" : "border-border hover:bg-panel2/60"
              }`}
            >
              <div className={`font-semibold ${exitStrategy === "alignment" ? "text-accent" : "text-gray-200"}`}>
                {exitStrategy === "alignment" ? "◉" : "○"} Theo alignment (v1.1)
              </div>
              <p className="text-[11px] text-gray-400 mt-1">
                MOMENTUM: SL rộng + TP1 2R (chốt 50%) rồi trailing EMA Fast. PULLBACK: TP1 ≈ 1.5R (50%),
                sau đó dời SL hòa vốn + trail. REVERSAL: SL chặt, TP = EMA Slow (~1R) chốt hết. Lật bias
                ngược → đóng ngay. Sizing theo rủi ro R.
              </p>
            </button>
            <button
              onClick={() => setExitStrategy("simple")}
              disabled={loading}
              className={`w-full text-left rounded-lg border p-3 transition-colors ${
                exitStrategy === "simple" ? "border-accent bg-panel2" : "border-border hover:bg-panel2/60"
              }`}
            >
              <div className={`font-semibold ${exitStrategy === "simple" ? "text-accent" : "text-gray-200"}`}>
                {exitStrategy === "simple" ? "◉" : "○"} TP/SL % cố định
              </div>
              <p className="text-[11px] text-gray-400 mt-1">
                Vào theo bias của state; thoát bằng TP/SL % cố định (giống backtest thường), có đòn bẩy
                &amp; ký quỹ.
              </p>
            </button>
          </div>

          {exitStrategy === "alignment" ? (
            <div className="mt-3 space-y-3">
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <Field label="Vốn ban đầu (USDT)">
                  <select className="input" value={form.initialCapitalUsdt} onChange={(e) => setF("initialCapitalUsdt", e.target.value)} disabled={loading}>
                    {[100, 200, 500, 1000, 2000, 5000, 10000].map((o) => <option key={o} value={o}>{o}</option>)}
                  </select>
                </Field>
                <Field label="Rủi ro / lệnh (%)" hint="Mỗi lệnh rủi ro % này của số dư khi chạm SL (1R). Khối lượng = (số dư × %)/R.">
                  <select className="input" value={align.riskPerTradePct} onChange={(e) => setA("riskPerTradePct", e.target.value)} disabled={loading}>
                    {[0.25, 0.5, 1, 1.5, 2, 3, 5, 7, 10, 15, 20].map((o) => <option key={o} value={o}>{o}</option>)}
                  </select>
                </Field>
                <Field label="Neo SL" hint="structure = sau EMA Slow/swing. atr = entry ± slAtrMult×ATR. protective = chọn mức xa hơn.">
                  <select className="input" value={slAnchor} onChange={(e) => setSlAnchor(e.target.value as any)} disabled={loading}>
                    <option value="protective">protective</option>
                    <option value="structure">structure</option>
                    <option value="atr">atr</option>
                  </select>
                </Field>
                <Field label="Trần lệnh đồng thời">
                  <select className="input" value={form.maxConcurrentPositions} onChange={(e) => setF("maxConcurrentPositions", e.target.value)} disabled={loading}>
                    {[1, 3, 5, 10, 20, 30, 50, 75, 100, 200, 500].map((o) => <option key={o} value={o}>{o}</option>)}
                  </select>
                </Field>
                <Field label="Swing lookback">
                  <select className="input" value={align.swingLookback} onChange={(e) => setA("swingLookback", e.target.value)} disabled={loading}>
                    {[5, 8, 10, 15, 20, 30, 50].map((o) => <option key={o} value={o}>{o}</option>)}
                  </select>
                </Field>
                <Field label="Đệm SL (× ATR)">
                  <select className="input" value={align.emaBufferAtr} onChange={(e) => setA("emaBufferAtr", e.target.value)} disabled={loading}>
                    {[0, 0.1, 0.25, 0.5, 0.75, 1].map((o) => <option key={o} value={o}>{o}</option>)}
                  </select>
                </Field>
                <Field label="SL ATR mult">
                  <select className="input" value={align.slAtrMult} onChange={(e) => setA("slAtrMult", e.target.value)} disabled={loading}>
                    {[1, 1.5, 2, 2.5, 3, 3.5, 4, 5].map((o) => <option key={o} value={o}>{o}</option>)}
                  </select>
                </Field>
                <Field label="Trần rủi ro DM (%)" hint="Tổng rủi ro các vị thế mở đồng thời ≤ % này (≈ giới hạn số vị thế = trần ÷ rủi ro mỗi lệnh). 0 = không giới hạn. Giúp tránh dồn vốn phi thực tế.">
                  <select className="input" value={maxPortfolioRiskPct} onChange={(e) => setMaxPortfolioRiskPct(Number(e.target.value))} disabled={loading}>
                    {[0, 5, 10, 20, 30, 50, 100].map((o) => <option key={o} value={o}>{o === 0 ? "∞" : o}</option>)}
                  </select>
                </Field>
                <Field label="Đòn bẩy" hint="Giữ risk-sizing 1%/lệnh nhưng thêm rủi ro thanh lý (chỉ ISOLATED): giá đi ngược ~100/đòn_bẩy% là cháy ký quỹ lệnh. 1× = không thanh lý.">
                  <select className="input" value={alignLeverage} onChange={(e) => setAlignLeverage(Number(e.target.value))} disabled={loading}>
                    {[1, 2, 3, 5, 10, 20, 25, 50, 75, 100, 125].map((o) => (
                      <option key={o} value={o}>{o === 1 ? "1× (không cháy)" : `${o}× (cháy khi ↓${(100 / o).toFixed(1)}%)`}</option>
                    ))}
                  </select>
                </Field>
                <Field label="Ký quỹ" hint="ISOLATED: mỗi lệnh cháy riêng khi giá đi ngược ~100/đòn_bẩy% (mất ký quỹ lệnh). CROSS: cả số dư đỡ lệnh -> SL luôn bảo vệ, không cháy lẻ (đòn bẩy gần như không ảnh hưởng P&L).">
                  <select className="input" value={marginMode} onChange={(e) => setMarginMode(e.target.value as any)} disabled={loading}>
                    <option value="ISOLATED">Isolated (có thanh lý)</option>
                    <option value="CROSS">Cross (SL bảo vệ)</option>
                  </select>
                </Field>
              </div>
              <div className="flex flex-wrap gap-4">
                <label className="flex items-center gap-2 text-xs text-gray-300">
                  <input type="checkbox" checked={riskCompound} onChange={(e) => setRiskCompound(e.target.checked)} disabled={loading} />
                  <Tooltip text="BẬT: rủi ro mỗi lệnh tính theo SỐ DƯ hiện tại (lãi kép) — ROI có thể phình rất lớn (ảo). TẮT: tính theo VỐN BAN ĐẦU cố định — equity tuyến tính, đánh giá edge thật hơn.">
                    <span>Tái đầu tư (lãi kép) <span className="text-gray-500">ⓘ</span></span>
                  </Tooltip>
                </label>
                <label className="flex items-center gap-2 text-xs text-gray-300">
                  <input type="checkbox" checked={globalOverlay} onChange={(e) => setGlobalOverlay(e.target.checked)} disabled={loading} />
                  Đóng khi lật bias ngược
                </label>
                <label className="flex items-center gap-2 text-xs text-gray-300">
                  <input type="checkbox" checked={hardExit} onChange={(e) => setHardExit(e.target.checked)} disabled={loading} />
                  Hard exit (cấu trúc lật / vượt EMA Slow)
                </label>
              </div>
            </div>
          ) : (
            <div className="mt-3 space-y-3">
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <Field label="Vốn ban đầu (USDT)">
                  <select className="input" value={form.initialCapitalUsdt} onChange={(e) => setF("initialCapitalUsdt", e.target.value)} disabled={loading}>
                    {[100, 200, 500, 1000, 2000, 5000, 10000].map((o) => <option key={o} value={o}>{o}</option>)}
                  </select>
                </Field>
                {sizeMode === "percent" ? (
                  <Field label="Ký quỹ / lệnh (% số dư)">
                    <select className="input" value={form.positionSizePct} onChange={(e) => setF("positionSizePct", e.target.value)} disabled={loading}>
                      {[1, 2, 3, 5, 10, 15, 20, 25, 50, 100].map((o) => <option key={o} value={o}>{o}</option>)}
                    </select>
                  </Field>
                ) : (
                  <Field label="Tiền / lệnh (USDT)">
                    <select className="input" value={form.orderSizeUsdt} onChange={(e) => setF("orderSizeUsdt", e.target.value)} disabled={loading}>
                      {[5, 10, 20, 50, 100, 200, 500, 1000].map((o) => <option key={o} value={o}>{o}</option>)}
                    </select>
                  </Field>
                )}
                <Field label="Đòn bẩy (x)">
                  <select className="input" value={form.leverage} onChange={(e) => setF("leverage", e.target.value)} disabled={loading}>
                    {[1, 2, 3, 5, 10, 20, 25, 50, 75, 100, 125].map((o) => <option key={o} value={o}>{o}</option>)}
                  </select>
                </Field>
                <Field label="Trần lệnh đồng thời">
                  <select className="input" value={form.maxConcurrentPositions} onChange={(e) => setF("maxConcurrentPositions", e.target.value)} disabled={loading}>
                    {[1, 3, 5, 10, 20, 30, 50, 75, 100, 200, 500].map((o) => <option key={o} value={o}>{o}</option>)}
                  </select>
                </Field>
                <Field label="TP %">
                  <select className="input" value={form.takeProfitPct} onChange={(e) => setF("takeProfitPct", e.target.value)} disabled={loading}>
                    {[5, 10, 15, 20, 25, 30, 40, 50, 75, 90, 100, 150, 200].map((o) => <option key={o} value={o}>{o}</option>)}
                  </select>
                </Field>
                <Field label="SL %">
                  <select className="input" value={form.stopLossPct} onChange={(e) => setF("stopLossPct", e.target.value)} disabled={loading}>
                    {[5, 10, 15, 20, 25, 30, 40, 50, 60, 75, 90].map((o) => <option key={o} value={o}>{o}</option>)}
                  </select>
                </Field>
              </div>
              <div className="flex flex-wrap gap-4">
                <div>
                  <label className="text-xs text-gray-400 uppercase">Khối lượng</label>
                  <div className="flex gap-2 mt-1">
                    <Seg active={sizeMode === "percent"} onClick={() => setSizeMode("percent")} disabled={loading}>% số dư</Seg>
                    <Seg active={sizeMode === "fixed"} onClick={() => setSizeMode("fixed")} disabled={loading}>Cố định USDT</Seg>
                  </div>
                </div>
                <div>
                  <label className="text-xs text-gray-400 uppercase">Ký quỹ</label>
                  <div className="flex gap-2 mt-1">
                    {(["CROSS", "ISOLATED"] as const).map((m) => (
                      <Seg key={m} active={marginMode === m} onClick={() => setMarginMode(m)} disabled={loading}>
                        {m === "CROSS" ? "Cross" : "Isolated"}
                      </Seg>
                    ))}
                  </div>
                </div>
                <div>
                  <label className="text-xs text-gray-400 uppercase">Cách tính TP/SL</label>
                  <div className="flex gap-2 mt-1">
                    {(["MARGIN", "PRICE"] as const).map((m) => (
                      <Seg key={m} active={tpSlMode === m} onClick={() => setTpSlMode(m)} disabled={loading}>
                        {m === "MARGIN" ? "Theo margin (ROI)" : "Theo giá"}
                      </Seg>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Chi phí giao dịch (áp dụng cả 2 chế độ) */}
        <div>
          <div className="text-xs text-accent uppercase font-semibold mb-2">💸 Chi phí giao dịch</div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Field label="Phí (%/chiều)" hint="Phí giao dịch mỗi chiều (vào + ra). Round-trip = 2× giá trị này, trừ thẳng vào % lãi/lỗ mỗi lệnh.">
              <select className="input" value={feePct} onChange={(e) => setFeePct(Number(e.target.value))} disabled={loading}>
                {[0, 0.02, 0.04, 0.05, 0.075, 0.1].map((o) => <option key={o} value={o}>{o}%</option>)}
              </select>
            </Field>
            <Field label="Trượt giá (%/chiều)" hint="Mức trượt giá mỗi chiều khi khớp lệnh. Cũng tính round-trip = 2×.">
              <select className="input" value={slippagePct} onChange={(e) => setSlippagePct(Number(e.target.value))} disabled={loading}>
                {[0, 0.01, 0.02, 0.05, 0.1, 0.2].map((o) => <option key={o} value={o}>{o}%</option>)}
              </select>
            </Field>
          </div>
          <p className="text-[11px] text-gray-500 mt-1">
            Tổng chi phí mỗi lệnh ≈ {(2 * (feePct + slippagePct)).toFixed(3)}% — trừ trực tiếp vào % lãi/lỗ.
          </p>
        </div>

        {/* Run */}
        <div className="flex items-center gap-3 flex-wrap border-t border-border pt-3">
          <button className="btn btn-primary" onClick={runBacktest} disabled={loading || fast >= slow}>
            {loading
              ? "Đang chạy..."
              : `🧪 Backtest EMA (${exitStrategy === "alignment" ? "v1.1" : "simple"}) → ${interval} · [${entryStates.join(",") || "—"}]`}
          </button>
          {error && <span className="text-down text-sm">{error}</span>}
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
              Kết quả: <b>{result.totalTrades}</b> lệnh · Win{" "}
              <b>{result.winRate.toFixed(1)}%</b> · ROI{" "}
              <b className={result.roiPct >= 0 ? "text-up" : "text-down"}>
                {result.roiPct >= 0 ? "+" : ""}
                {result.roiPct}%
              </b>{" "}
              · năm {new Date(result.from).getUTCFullYear()}
            </span>
            <button className="btn btn-primary" onClick={saveResult} disabled={saving || !runParams}>
              {saving ? "Đang lưu..." : "💾 Lưu lịch sử"}
            </button>
          </div>
          <BacktestResults
            result={result}
            emptyHint="Không có tín hiệu đổi state vào các state đã chọn trong khoảng này — thử thêm state hoặc giảm epsilon."
          />
        </>
      )}

      {/* ===== Lịch sử backtest đã lưu (chỉ EMA) ===== */}
      <SavedBacktestHistory refreshKey={historyKey} strategy="EMA" onOpen={openRecord} />
    </div>
  );
}
