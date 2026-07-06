import { useEffect } from "react";
import { api } from "../api/client";
import { useStore } from "../store/useStore";

function Stat({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <div className="card">
      <div className="text-xs text-gray-400 uppercase">{label}</div>
      <div className={`text-2xl font-bold mt-1 ${accent ?? ""}`}>{value}</div>
    </div>
  );
}

export default function Overview() {
  const overview = useStore((s) => s.overview);
  const setOverview = useStore((s) => s.setOverview);
  const lastScanAt = useStore((s) => s.lastScanAt);

  useEffect(() => {
    const load = () => api.getOverview().then(setOverview).catch(() => {});
    load();
    const t = setInterval(load, 10000);
    return () => clearInterval(t);
  }, [setOverview]);

  const pnl = overview?.todayPnl ?? 0;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-bold">Overview</h2>
        <span className="text-xs text-gray-400">
          Lần scan gần nhất: {lastScanAt ? new Date(lastScanAt).toLocaleTimeString() : "—"}
        </span>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <Stat label="Coin đang scan" value={String(overview?.coinsScanning ?? "—")} />
        <Stat
          label="Tín hiệu LONG"
          value={String(overview?.longSignals ?? "—")}
          accent="text-accent"
        />
        <Stat label="Lệnh đang mở" value={String(overview?.openPositions ?? "—")} />
        <Stat
          label="Lợi nhuận hôm nay"
          value={`${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)} USDT`}
          accent={pnl >= 0 ? "text-up" : "text-down"}
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Stat label="Lệnh hôm nay" value={String(overview?.todayTradeCount ?? 0)} />
        <Stat
          label="Tỷ lệ thắng"
          value={`${(overview?.winRate ?? 0).toFixed(1)}%`}
          accent="text-up"
        />
        <div className="card">
          <div className="text-xs text-gray-400 uppercase">Trạng thái bot</div>
          <div className="text-up text-lg font-semibold mt-1">● Đang chạy</div>
        </div>
      </div>
    </div>
  );
}
