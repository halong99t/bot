import { useEffect, useState } from "react";
import { toast } from "sonner";
import { api } from "../api/client";
import { useStore } from "../store/useStore";
import type { Signal } from "../types";
import Chart from "../components/Chart";

export default function Signals() {
  const signals = useStore((s) => s.signals);
  const setSignals = useStore((s) => s.setSignals);
  const [selected, setSelected] = useState<Signal | null>(null);

  useEffect(() => {
    api.getSignals().then(setSignals).catch(() => {});
  }, [setSignals]);

  const execute = async (id: number) => {
    try {
      await api.executeSignal(id);
      toast.success("Đã gửi lệnh vào");
      setSignals(await api.getSignals());
    } catch (e: any) {
      toast.error(e?.response?.data?.message ?? "Vào lệnh thất bại");
    }
  };
  const cancel = async (id: number) => {
    await api.cancelSignal(id);
    toast("Đã hủy tín hiệu");
    setSignals(await api.getSignals());
  };

  return (
    <div className="space-y-4">
      <h2 className="text-xl font-bold">Trading Signals</h2>

      {selected && <Chart symbol={selected.symbol} signal={selected} />}

      <div className="card overflow-x-auto p-0">
        <table className="w-full min-w-[820px]">
          <thead>
            <tr>
              <th className="th">Symbol</th>
              <th className="th">Phát hiện</th>
              <th className="th">Entry</th>
              <th className="th">TP</th>
              <th className="th">SL</th>
              <th className="th">Xác suất</th>
              <th className="th">Trạng thái</th>
              <th className="th">Hành động</th>
            </tr>
          </thead>
          <tbody>
            {signals.map((s) => (
              <tr
                key={s.id}
                className="hover:bg-panel2 cursor-pointer"
                onClick={() => setSelected(s)}
              >
                <td className="td font-medium">{s.symbol}</td>
                <td className="td text-xs text-gray-400">
                  {new Date(s.detectedAt).toLocaleString()}
                </td>
                <td className="td">{s.entryPrice}</td>
                <td className="td text-up">{s.takeProfit.toFixed(4)}</td>
                <td className="td text-down">{s.stopLoss.toFixed(4)}</td>
                <td className="td">
                  <span className="inline-block bg-panel2 border border-border rounded px-2 py-0.5 text-xs">
                    {s.probability}%
                  </span>
                </td>
                <td className="td text-xs">{s.status}</td>
                <td className="td" onClick={(e) => e.stopPropagation()}>
                  {s.status === "PENDING" && (
                    <div className="flex gap-2">
                      <button className="btn btn-primary" onClick={() => execute(s.id)}>
                        Vào lệnh
                      </button>
                      <button className="btn btn-ghost" onClick={() => cancel(s.id)}>
                        Hủy
                      </button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
            {signals.length === 0 && (
              <tr>
                <td className="td text-gray-500" colSpan={8}>
                  Chưa có tín hiệu nào.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
