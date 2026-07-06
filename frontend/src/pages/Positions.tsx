import { useEffect } from "react";
import { toast } from "sonner";
import { api } from "../api/client";
import { useStore } from "../store/useStore";

export default function Positions() {
  const positions = useStore((s) => s.positions);
  const setPositions = useStore((s) => s.setPositions);

  useEffect(() => {
    const load = () => api.getPositions("OPEN").then(setPositions).catch(() => {});
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [setPositions]);

  const close = async (id: number) => {
    try {
      await api.closePosition(id);
      toast.success("Đã đóng lệnh");
      setPositions(await api.getPositions("OPEN"));
    } catch (e: any) {
      toast.error(e?.response?.data?.message ?? "Đóng lệnh thất bại");
    }
  };

  return (
    <div className="space-y-4">
      <h2 className="text-xl font-bold">Open Positions</h2>

      <div className="card overflow-x-auto p-0">
        <table className="w-full min-w-[820px]">
          <thead>
            <tr>
              <th className="th">Symbol</th>
              <th className="th">Side</th>
              <th className="th">Entry</th>
              <th className="th">Giá hiện tại</th>
              <th className="th">Qty</th>
              <th className="th">TP / SL</th>
              <th className="th">PNL</th>
              <th className="th">Hành động</th>
            </tr>
          </thead>
          <tbody>
            {positions.map((p) => (
              <tr key={p.id} className="hover:bg-panel2">
                <td className="td font-medium">{p.symbol}</td>
                <td className="td text-up">{p.side} ×{p.leverage}</td>
                <td className="td">{p.entryPrice.toFixed(4)}</td>
                <td className="td">{p.currentPrice?.toFixed(4) ?? "—"}</td>
                <td className="td">{p.quantity}</td>
                <td className="td text-xs">
                  <span className="text-up">{p.takeProfit.toFixed(4)}</span> /{" "}
                  <span className="text-down">{p.stopLoss.toFixed(4)}</span>
                </td>
                <td className={`td font-semibold ${p.pnl >= 0 ? "text-up" : "text-down"}`}>
                  {p.pnl >= 0 ? "+" : ""}
                  {p.pnl.toFixed(2)} ({p.pnlPct.toFixed(2)}%)
                </td>
                <td className="td">
                  <button className="btn btn-danger" onClick={() => close(p.id)}>
                    Đóng
                  </button>
                </td>
              </tr>
            ))}
            {positions.length === 0 && (
              <tr>
                <td className="td text-gray-500" colSpan={8}>
                  Không có lệnh đang mở.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
