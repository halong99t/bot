import { useEffect, useState } from "react";
import { api } from "../api/client";
import type { Trade } from "../types";

export default function History() {
  const [trades, setTrades] = useState<Trade[]>([]);

  useEffect(() => {
    api.getTrades().then(setTrades).catch(() => {});
  }, []);

  const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
  const wins = trades.filter((t) => t.pnl > 0).length;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h2 className="text-xl font-bold">Trade History</h2>
        <div className="flex gap-4 text-sm">
          <span>
            Tổng PNL:{" "}
            <span className={totalPnl >= 0 ? "text-up" : "text-down"}>
              {totalPnl.toFixed(2)} USDT
            </span>
          </span>
          <span className="text-gray-400">
            Win {wins}/{trades.length}
          </span>
        </div>
      </div>

      <div className="card overflow-x-auto p-0">
        <table className="w-full min-w-[820px]">
          <thead>
            <tr>
              <th className="th">Symbol</th>
              <th className="th">Entry</th>
              <th className="th">Exit</th>
              <th className="th">Qty</th>
              <th className="th">Lý do</th>
              <th className="th">Profit %</th>
              <th className="th">PNL</th>
              <th className="th">Đóng lúc</th>
            </tr>
          </thead>
          <tbody>
            {trades.map((t) => (
              <tr key={t.id} className="hover:bg-panel2">
                <td className="td font-medium">{t.symbol}</td>
                <td className="td">{t.entryPrice.toFixed(4)}</td>
                <td className="td">{t.exitPrice.toFixed(4)}</td>
                <td className="td">{t.quantity}</td>
                <td className="td">
                  <span
                    className={`text-xs px-2 py-0.5 rounded ${
                      t.closeReason === "TP"
                        ? "bg-up/20 text-up"
                        : t.closeReason === "SL"
                        ? "bg-down/20 text-down"
                        : "bg-panel2 text-gray-300"
                    }`}
                  >
                    {t.closeReason}
                  </span>
                </td>
                <td className={`td ${t.pnlPct >= 0 ? "text-up" : "text-down"}`}>
                  {t.pnlPct >= 0 ? "+" : ""}
                  {t.pnlPct.toFixed(2)}%
                </td>
                <td className={`td font-semibold ${t.pnl >= 0 ? "text-up" : "text-down"}`}>
                  {t.pnl.toFixed(2)}
                </td>
                <td className="td text-xs text-gray-400">
                  {new Date(t.closedAt).toLocaleString()}
                </td>
              </tr>
            ))}
            {trades.length === 0 && (
              <tr>
                <td className="td text-gray-500" colSpan={8}>
                  Chưa có giao dịch nào.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
