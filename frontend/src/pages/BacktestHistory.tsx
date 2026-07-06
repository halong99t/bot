import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { api } from "../api/client";
import type { BacktestHistoryItem, BacktestStrategy } from "../types";

// Tóm tắt bộ thông số thành chuỗi ngắn (nhận biết nhanh cấu hình).
function paramsBrief(p: Record<string, unknown>): string {
  const parts: string[] = [];
  const push = (label: string, v: unknown) => {
    if (v !== undefined && v !== null && v !== "") parts.push(label ? `${label} ${v}` : `${v}`);
  };
  if (p.exitStrategy || p.fastPeriod) push("EMA", `${p.fastPeriod}/${p.slowPeriod}`);
  if (Array.isArray(p.entryStates)) push("states", (p.entryStates as string[]).join("+"));
  if (p.exitStrategy) push("exit", p.exitStrategy);
  if (p.riskPerTradePct !== undefined) push("risk", `${p.riskPerTradePct}%`);
  if (p.takeProfitPct !== undefined) push("TP", `${p.takeProfitPct}%`);
  if (p.stopLossPct !== undefined) push("SL", `${p.stopLossPct}%`);
  if (p.leverage) push("lev", `${p.leverage}x`);
  if (p.tpSlMode) push("", `${p.tpSlMode}`);
  if (p.minDropPct !== undefined) push("drop", `${p.minDropPct}%`);
  if (p.minSidewayCandles !== undefined) push("sw", `${p.minSidewayCandles}`);
  if (p.minRisePct !== undefined) push("rise", `${p.minRisePct}%`);
  return parts.join(" · ") || "—";
}

// EMA đứng trước (focus vào EMA)
const STRATEGY_TABS: { key: BacktestStrategy; label: string; desc: string }[] = [
  { key: "EMA", label: "EMA Classifier", desc: "6 trạng thái P/F/S — vào theo state, thoát theo alignment" },
  { key: "LONG", label: "Mô hình LONG", desc: "Chiến lược giảm sâu → sideway → breakout 3 nến" },
];

const periodLabel = (h: BacktestHistoryItem) => (h.month ? `T${h.month}/${h.year}` : String(h.year));

function StatCard({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: "up" | "down" }) {
  return (
    <div className="card py-3">
      <div className="text-[11px] text-gray-400 uppercase">{label}</div>
      <div className={`text-lg font-bold ${tone === "up" ? "text-up" : tone === "down" ? "text-down" : ""}`}>
        {value}
      </div>
      {sub && <div className="text-[11px] text-gray-500 mt-0.5">{sub}</div>}
    </div>
  );
}

// Nhãn dễ đọc cho các trường params (dùng cho bộ lọc động). Không có trong map -> dùng luôn key.
const PARAM_LABELS: Record<string, string> = {
  fastPeriod: "EMA Fast",
  slowPeriod: "EMA Slow",
  epsilonMode: "Epsilon mode",
  epsilonValue: "Epsilon value",
  atrPeriod: "ATR period",
  exitStrategy: "Exit",
  slAnchor: "Neo SL",
  slAtrMult: "SL ATR×",
  swingLookback: "Swing",
  emaBufferAtr: "Đệm SL",
  riskPerTradePct: "Rủi ro %",
  takeProfitPct: "TP %",
  stopLossPct: "SL %",
  leverage: "Đòn bẩy",
  tpSlMode: "Kiểu TP/SL",
  marginMode: "Ký quỹ",
  positionSizePct: "Ký quỹ %",
  orderSizeUsdt: "Tiền/lệnh",
  maxConcurrentPositions: "Trần lệnh",
  initialCapitalUsdt: "Vốn",
  minDropPct: "Giảm min %",
  minSidewayCandles: "Sideway",
  maxSidewayRangePct: "Biên SW %",
  minRisePct: "3 nến %",
};

// 1 ô lọc dạng nhãn-trên-select, nổi bật khi đang chọn (≠ Tất cả).
function FilterSelect({
  label,
  value,
  onChange,
  options,
  fmt = String,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: (string | number)[];
  fmt?: (o: string | number) => string;
}) {
  const active = value !== "all";
  return (
    <div className="flex flex-col gap-1">
      <label className="text-[10px] text-gray-400 uppercase tracking-wide">{label}</label>
      <select
        className={`input h-8 py-0 text-sm min-w-[6rem] ${active ? "border-accent text-accent" : ""}`}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="all">Tất cả</option>
        {options.map((o) => (
          <option key={String(o)} value={String(o)}>
            {fmt(o)}
          </option>
        ))}
      </select>
    </div>
  );
}

export default function BacktestHistory() {
  const navigate = useNavigate();
  const [all, setAll] = useState<BacktestHistoryItem[]>([]);
  const [tab, setTab] = useState<BacktestStrategy>("EMA"); // focus EMA
  const [yearFilter, setYearFilter] = useState<number | "all">("all");
  const [monthFilter, setMonthFilter] = useState<number | "all">("all");
  const [intervalFilter, setIntervalFilter] = useState<string>("all");
  const [paramFilters, setParamFilters] = useState<Record<string, string>>({});

  const load = async () => {
    try {
      setAll(await api.listBacktestHistory());
    } catch {
      toast.error("Không tải được lịch sử");
    }
  };

  useEffect(() => {
    load();
  }, []);

  // Lọc theo tab (strategy) -> năm -> tháng
  const byStrategy = useMemo(() => all.filter((h) => h.strategy === tab), [all, tab]);
  const years = useMemo(
    () => [...new Set(byStrategy.map((h) => h.year))].sort((a, b) => b - a),
    [byStrategy]
  );
  // Các tháng có dữ liệu (trong phạm vi năm đang lọc)
  const months = useMemo(() => {
    const pool = yearFilter === "all" ? byStrategy : byStrategy.filter((h) => h.year === yearFilter);
    return [...new Set(pool.map((h) => h.month))].filter(Boolean).sort((a, b) => a - b);
  }, [byStrategy, yearFilter]);

  // Các khung nến có trong dữ liệu
  const intervals = useMemo(
    () => [...new Set(byStrategy.map((h) => h.interval))].sort(),
    [byStrategy]
  );
  // Bộ lọc cấu hình ĐỘNG: chỉ lấy các trường params có trong lịch sử & có ≥2 giá trị khác nhau.
  const configFacets = useMemo(() => {
    const keys = new Set<string>();
    for (const h of byStrategy) for (const k of Object.keys(h.params ?? {})) keys.add(k);
    const facets: { key: string; label: string; options: (string | number)[] }[] = [];
    for (const key of keys) {
      const raw = byStrategy
        .map((h) => h.params?.[key])
        .filter((v) => v !== undefined && v !== null);
      if (raw.some((v) => typeof v === "object")) continue; // bỏ mảng/đối tượng (vd entryStates)
      const vals = [...new Set(raw)] as (string | number)[];
      if (vals.length < 2) continue; // chỉ hiện trường thực sự có nhiều giá trị để lọc
      vals.sort((a, b) =>
        typeof a === "number" && typeof b === "number" ? a - b : String(a).localeCompare(String(b))
      );
      facets.push({ key, label: PARAM_LABELS[key] ?? key, options: vals });
    }
    const order = Object.keys(PARAM_LABELS);
    facets.sort((a, b) => {
      const ia = order.indexOf(a.key);
      const ib = order.indexOf(b.key);
      return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib);
    });
    return facets;
  }, [byStrategy]);

  const hasConfigFilter =
    intervalFilter !== "all" || Object.values(paramFilters).some((v) => v && v !== "all");

  const rows = useMemo(
    () =>
      byStrategy.filter(
        (h) =>
          (yearFilter === "all" || h.year === yearFilter) &&
          (monthFilter === "all" || h.month === monthFilter) &&
          (intervalFilter === "all" || h.interval === intervalFilter) &&
          configFacets.every((f) => {
            const sel = paramFilters[f.key];
            return !sel || sel === "all" || String(h.params?.[f.key]) === sel;
          })
      ),
    [byStrategy, yearFilter, monthFilter, intervalFilter, paramFilters, configFacets]
  );

  // Thống kê phân tích trên tập đang xem
  const stats = useMemo(() => {
    if (!rows.length) return null;
    const rois = rows.map((r) => r.summary.roiPct);
    const avg = rois.reduce((a, b) => a + b, 0) / rois.length;
    const best = rows.reduce((m, r) => (r.summary.roiPct > m.summary.roiPct ? r : m));
    const worst = rows.reduce((m, r) => (r.summary.roiPct < m.summary.roiPct ? r : m));
    const avgWin = rows.reduce((a, r) => a + r.summary.winRate, 0) / rows.length;
    const trades = rows.reduce((a, r) => a + r.summary.totalTrades, 0);
    const pnl = rows.reduce((a, r) => a + (r.summary.finalBalanceUsdt - r.summary.initialCapitalUsdt), 0);
    const profitable = rows.filter((r) => r.summary.roiPct > 0).length;
    return { count: rows.length, avg, best, worst, avgWin, trades, pnl, profitable };
  }, [rows]);

  const openDetail = (item: BacktestHistoryItem) => navigate(`/backtest-history/${item.id}`);

  const remove = async (id: number) => {
    try {
      await api.deleteBacktestHistory(id);
      setAll((h) => h.filter((x) => x.id !== id));
      toast.success("Đã xóa lịch sử");
    } catch {
      toast.error("Xóa thất bại");
    }
  };

  const changeTab = (t: BacktestStrategy) => {
    setTab(t);
    setYearFilter("all");
    setMonthFilter("all");
    setIntervalFilter("all");
    setParamFilters({});
  };

  // Xóa toàn bộ bản ghi trong phạm vi đang lọc
  const clearFiltered = async () => {
    if (!rows.length) return;
    if (!window.confirm(`Xóa ${rows.length} bản ghi đang hiển thị?\nHành động này không thể hoàn tác.`))
      return;
    try {
      if (hasConfigFilter) {
        // Có lọc cấu hình (client-side) -> xóa đúng các bản ghi đang hiển thị theo id
        const ids = rows.map((r) => r.id);
        await Promise.all(ids.map((id) => api.deleteBacktestHistory(id)));
        setAll((h) => h.filter((x) => !ids.includes(x.id)));
        toast.success(`Đã xóa ${ids.length} bản ghi`);
      } else {
        // Chỉ lọc strategy/năm/tháng -> dùng endpoint xóa hàng loạt
        const params: { strategy: BacktestStrategy; year?: number; month?: number } = { strategy: tab };
        if (yearFilter !== "all") params.year = yearFilter;
        if (monthFilter !== "all") params.month = monthFilter;
        const { count } = await api.clearBacktestHistory(params);
        await load();
        toast.success(`Đã xóa ${count} bản ghi`);
      }
    } catch {
      toast.error("Xóa thất bại");
    }
  };

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-xl font-bold">Lịch sử Backtest</h2>
        <p className="text-xs text-gray-400 mt-1">
          Kho lịch sử đã lưu, tách riêng theo chiến lược để phân tích. Mỗi lần chạy được tách theo{" "}
          <b>từng tháng</b> — mỗi (bộ thông số + khung + tháng) là 1 bản ghi (chạy lại sẽ ghi đè).
        </p>
      </div>

      {/* Bộ lọc — 1 khối gọn: chiến lược + facet động lấy từ dữ liệu */}
      {(() => {
        const anyActive = yearFilter !== "all" || monthFilter !== "all" || hasConfigFilter;
        const resetAll = () => {
          setYearFilter("all");
          setMonthFilter("all");
          setIntervalFilter("all");
          setParamFilters({});
        };
        return (
          <div className="card p-0 overflow-hidden">
            {/* Header: chọn chiến lược + đếm bản ghi */}
            <div className="flex items-center gap-2 flex-wrap px-3 py-2 border-b border-border bg-panel2/40">
              <div className="flex gap-1">
                {STRATEGY_TABS.map((s) => {
                  const n = all.filter((h) => h.strategy === s.key).length;
                  return (
                    <button
                      key={s.key}
                      onClick={() => changeTab(s.key)}
                      title={s.desc}
                      className={`btn ${tab === s.key ? "btn-primary" : "btn-ghost"}`}
                    >
                      {s.label} <span className="opacity-70">({n})</span>
                    </button>
                  );
                })}
              </div>
              <span className="ml-auto text-xs text-gray-400">
                Đang xem <b className="text-gray-100">{rows.length}</b>
                <span className="text-gray-500">/{byStrategy.length}</span> bản ghi
              </span>
            </div>

            {/* Hàng facet lọc */}
            <div className="flex flex-wrap items-end gap-x-4 gap-y-3 px-3 py-3">
              {years.length > 1 && (
                <FilterSelect
                  label="Năm"
                  value={String(yearFilter)}
                  onChange={(v) => {
                    setYearFilter(v === "all" ? "all" : Number(v));
                    setMonthFilter("all");
                  }}
                  options={years}
                />
              )}
              {months.length > 1 && (
                <FilterSelect
                  label="Tháng"
                  value={String(monthFilter)}
                  onChange={(v) => setMonthFilter(v === "all" ? "all" : Number(v))}
                  options={months}
                  fmt={(o) => `Tháng ${o}`}
                />
              )}
              {intervals.length > 1 && (
                <FilterSelect
                  label="Khung nến"
                  value={intervalFilter}
                  onChange={setIntervalFilter}
                  options={intervals}
                />
              )}
              {configFacets.map((f) => (
                <FilterSelect
                  key={f.key}
                  label={f.label}
                  value={paramFilters[f.key] ?? "all"}
                  onChange={(v) => setParamFilters((p) => ({ ...p, [f.key]: v }))}
                  options={f.options}
                />
              ))}

              <div className="flex items-center gap-2 ml-auto self-end">
                {anyActive && (
                  <button className="btn btn-ghost text-xs py-1 px-2" onClick={resetAll}>
                    ✕ Bỏ lọc
                  </button>
                )}
                <button
                  className="btn btn-ghost text-xs py-1 px-2 text-down"
                  onClick={clearFiltered}
                  disabled={!rows.length}
                  title="Xóa các bản ghi đang hiển thị"
                >
                  🗑 Xóa hiển thị
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Thống kê phân tích */}
      {stats ? (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
          <StatCard label="Số bản ghi" value={String(stats.count)} sub={`${stats.trades} lệnh · ${stats.profitable} tháng lãi`} />
          <StatCard
            label="ROI trung bình / tháng"
            value={`${stats.avg >= 0 ? "+" : ""}${stats.avg.toFixed(1)}%`}
            tone={stats.avg >= 0 ? "up" : "down"}
          />
          <StatCard
            label="Tháng tốt nhất"
            value={`+${stats.best.summary.roiPct}%`}
            sub={`${periodLabel(stats.best)} · ${stats.best.interval}`}
            tone="up"
          />
          <StatCard
            label="Tháng tệ nhất"
            value={`${stats.worst.summary.roiPct}%`}
            sub={`${periodLabel(stats.worst)} · ${stats.worst.interval}`}
            tone="down"
          />
          <StatCard label="Win rate TB" value={`${stats.avgWin.toFixed(1)}%`} />
          <StatCard
            label="Tổng lãi/lỗ"
            value={`${stats.pnl >= 0 ? "+" : ""}${Math.round(stats.pnl).toLocaleString()} $`}
            tone={stats.pnl >= 0 ? "up" : "down"}
          />
        </div>
      ) : null}

      {/* Bảng lịch sử */}
      <div className="card overflow-x-auto p-0">
        {rows.length === 0 ? (
          <p className="px-3 py-4 text-sm text-gray-500">
            Chưa có lịch sử {tab === "LONG" ? "mô hình LONG" : "EMA"}
            {yearFilter !== "all" ? ` cho năm ${yearFilter}` : ""}
            {monthFilter !== "all" ? ` tháng ${monthFilter}` : ""}. Vào trang{" "}
            <b>{tab === "LONG" ? "Backtest" : "EMA Classifier"}</b> chạy rồi bấm <b>💾 Lưu</b>.
          </p>
        ) : (
          <table className="w-full min-w-[900px]">
            <thead>
              <tr>
                <th className="th">Tháng</th>
                <th className="th">Khung</th>
                <th className="th">Thông số</th>
                <th className="th">Lệnh</th>
                <th className="th">Win %</th>
                <th className="th">ROI %</th>
                <th className="th">PNL USDT</th>
                <th className="th">Max DD</th>
                <th className="th">Cập nhật</th>
                <th className="th"></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((h) => {
                const pnl = h.summary.finalBalanceUsdt - h.summary.initialCapitalUsdt;
                return (
                  <tr
                    key={h.id}
                    className="cursor-pointer hover:bg-panel2"
                    onClick={() => openDetail(h)}
                  >
                    <td className="td font-semibold text-accent">{periodLabel(h)}</td>
                    <td className="td font-semibold">{h.interval}</td>
                    <td
                      className="td text-xs text-gray-300 max-w-[300px] truncate"
                      title={JSON.stringify(h.params, null, 2)}
                    >
                      {h.label ? <b>{h.label} · </b> : null}
                      {paramsBrief(h.params)}
                    </td>
                    <td className="td">{h.summary.totalTrades}</td>
                    <td className={`td ${h.summary.winRate >= 50 ? "text-up" : "text-down"}`}>
                      {h.summary.winRate.toFixed(1)}%
                    </td>
                    <td className={`td ${h.summary.roiPct >= 0 ? "text-up" : "text-down"}`}>
                      {h.summary.roiPct >= 0 ? "+" : ""}
                      {h.summary.roiPct}%
                    </td>
                    <td className={`td ${pnl >= 0 ? "text-up" : "text-down"}`}>
                      {pnl >= 0 ? "+" : ""}
                      {Math.round(pnl).toLocaleString()} $
                    </td>
                    <td className="td text-down">{h.summary.maxDrawdownUsdt} $</td>
                    <td className="td text-xs text-gray-400">{new Date(h.updatedAt).toLocaleString()}</td>
                    <td className="td whitespace-nowrap">
                      <button
                        className="btn btn-ghost text-xs py-0.5 px-2"
                        onClick={(e) => {
                          e.stopPropagation();
                          openDetail(h);
                        }}
                      >
                        Chi tiết
                      </button>
                      <button
                        className="btn btn-ghost text-xs py-0.5 px-2 text-down"
                        onClick={(e) => {
                          e.stopPropagation();
                          remove(h.id);
                        }}
                      >
                        Xóa
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
