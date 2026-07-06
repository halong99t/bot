import { useEffect, useState } from "react";
import { toast } from "sonner";
import { api } from "../api/client";
import type { BacktestHistoryItem, BacktestStrategy } from "../types";

interface Props {
  // Đổi giá trị này (vd tăng số) để buộc tải lại danh sách sau khi lưu.
  refreshKey?: number;
  // Lọc theo khung nến nếu muốn (vd trang chỉ quan tâm 1 nhóm). Bỏ trống = tất cả.
  interval?: string;
  // Lọc theo loại chiến lược (LONG/EMA). Bỏ trống = tất cả.
  strategy?: BacktestStrategy;
  // Mở 1 bản ghi -> trang cha nạp result vào khu vực xem kết quả.
  onOpen: (item: BacktestHistoryItem) => void | Promise<void>;
}

// Rút gọn params thành chuỗi ngắn để xem nhanh (đủ nhận ra "bộ thông số" nào).
function paramsBrief(p: Record<string, unknown>): string {
  const parts: string[] = [];
  const push = (label: string, v: unknown) => {
    if (v !== undefined && v !== null && v !== "") parts.push(`${label} ${v}`);
  };
  if (p.exitStrategy) push("EMA", `${p.fastPeriod}/${p.slowPeriod}`);
  if (Array.isArray(p.entryStates)) push("states", (p.entryStates as string[]).join("+"));
  if (p.exitStrategy) push("exit", p.exitStrategy);
  push("TP", p.takeProfitPct !== undefined ? `${p.takeProfitPct}%` : undefined);
  push("SL", p.stopLossPct !== undefined ? `${p.stopLossPct}%` : undefined);
  if (p.riskPerTradePct !== undefined) push("risk", `${p.riskPerTradePct}%`);
  push("lev", p.leverage ? `${p.leverage}x` : undefined);
  if (p.tpSlMode) push("", `${p.tpSlMode}`);
  if (p.minDropPct !== undefined) push("drop", `${p.minDropPct}%`);
  return parts.join(" · ") || "—";
}

export default function SavedBacktestHistory({ refreshKey, interval, strategy, onOpen }: Props) {
  const [history, setHistory] = useState<BacktestHistoryItem[]>([]);
  const [loadingId, setLoadingId] = useState<number | null>(null);

  const load = async () => {
    try {
      const params: { interval?: string; strategy?: BacktestStrategy } = {};
      if (interval) params.interval = interval;
      if (strategy) params.strategy = strategy;
      setHistory(await api.listBacktestHistory(params));
    } catch {
      /* ignore */
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey, interval, strategy]);

  const open = async (item: BacktestHistoryItem) => {
    setLoadingId(item.id);
    try {
      await onOpen(item);
    } finally {
      setLoadingId(null);
    }
  };

  const remove = async (id: number) => {
    try {
      await api.deleteBacktestHistory(id);
      setHistory((h) => h.filter((x) => x.id !== id));
      toast.success("Đã xóa lịch sử");
    } catch {
      toast.error("Xóa thất bại");
    }
  };

  return (
    <div className="card overflow-x-auto p-0">
      <div className="px-3 py-2 font-semibold border-b border-border flex items-center justify-between gap-2 flex-wrap">
        <span>📚 Lịch sử đã lưu ({history.length})</span>
        <span className="text-[11px] text-gray-500 font-normal">
          Mỗi bộ thông số + khung nến + năm chỉ giữ 1 bản ghi (chạy lại sẽ ghi đè).
        </span>
      </div>
      {history.length === 0 ? (
        <p className="px-3 py-3 text-sm text-gray-500">
          Chưa có lịch sử. Chạy backtest rồi bấm <b>💾 Lưu</b> ở phần kết quả.
        </p>
      ) : (
        <table className="w-full min-w-[820px]">
          <thead>
            <tr>
              <th className="th">Tháng</th>
              <th className="th">Khung</th>
              <th className="th">Thông số</th>
              <th className="th">Lệnh</th>
              <th className="th">Win %</th>
              <th className="th">ROI %</th>
              <th className="th">Số dư cuối</th>
              <th className="th">Cập nhật</th>
              <th className="th"></th>
            </tr>
          </thead>
          <tbody>
            {history.map((h) => (
              <tr key={h.id} className="hover:bg-panel2">
                <td className="td font-semibold">{h.month ? `T${h.month}/${h.year}` : h.year}</td>
                <td className="td text-accent font-semibold">{h.interval}</td>
                <td className="td text-xs text-gray-300 max-w-[280px] truncate" title={JSON.stringify(h.params, null, 2)}>
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
                <td className="td">{h.summary.finalBalanceUsdt.toLocaleString()} $</td>
                <td className="td text-xs text-gray-400">{new Date(h.updatedAt).toLocaleString()}</td>
                <td className="td whitespace-nowrap">
                  <button
                    className="btn btn-ghost text-xs py-0.5 px-2"
                    onClick={() => open(h)}
                    disabled={loadingId === h.id}
                  >
                    {loadingId === h.id ? "..." : "Mở"}
                  </button>
                  <button className="btn btn-ghost text-xs py-0.5 px-2 text-down" onClick={() => remove(h.id)}>
                    Xóa
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
