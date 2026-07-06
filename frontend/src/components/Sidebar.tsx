import { NavLink } from "react-router-dom";
import {
  LayoutDashboard,
  Radar,
  Signal,
  Briefcase,
  History,
  FlaskConical,
  Archive,
  Activity,
  HardDrive,
  Settings,
  Zap,
  Wifi,
  WifiOff,
} from "lucide-react";
import { useStore } from "../store/useStore";

const links = [
  { to: "/overview", label: "Overview", Icon: LayoutDashboard },
  { to: "/scanner", label: "Market Scanner", Icon: Radar },
  { to: "/signals", label: "Trading Signals", Icon: Signal },
  { to: "/positions", label: "Open Positions", Icon: Briefcase },
  { to: "/history", label: "Trade History", Icon: History },
  { to: "/backtest", label: "Backtest", Icon: FlaskConical },
  { to: "/backtest-history", label: "Lịch sử Backtest", Icon: Archive },
  { to: "/ema", label: "EMA Classifier", Icon: Activity },
  { to: "/local-data", label: "Dữ liệu Local (1m)", Icon: HardDrive },
  { to: "/settings", label: "Settings", Icon: Settings },
];

export default function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const connected = useStore((s) => s.connected);

  return (
    <aside className="w-60 max-w-[80vw] shrink-0 bg-panel border-r border-border flex flex-col h-full">
      <div className="px-5 py-4 border-b border-border flex items-start justify-between gap-2">
        <div>
          <h1 className="text-lg font-bold text-accent flex items-center gap-2">
            <Zap size={20} className="text-accent" /> Crypto Bot
          </h1>
          <div className="flex items-center gap-2 mt-1 text-xs">
            {connected ? (
              <Wifi size={13} className="text-up" />
            ) : (
              <WifiOff size={13} className="text-down" />
            )}
            <span className="text-gray-400">
              {connected ? "Realtime connected" : "Disconnected"}
            </span>
          </div>
        </div>
        {/* Nút đóng — chỉ hiện trên mobile (khi sidebar là drawer) */}
        {onNavigate && (
          <button onClick={onNavigate} className="md:hidden text-gray-400 hover:text-gray-200 text-xl leading-none" aria-label="Đóng menu">
            ✕
          </button>
        )}
      </div>

      <nav className="flex-1 p-3 space-y-1 overflow-y-auto">
        {links.map(({ to, label, Icon }) => (
          <NavLink
            key={to}
            to={to}
            onClick={onNavigate}
            className={({ isActive }) =>
              `flex items-center gap-3 px-3 py-2 rounded text-sm ${
                isActive
                  ? "bg-panel2 text-accent border border-border"
                  : "text-gray-300 hover:bg-panel2"
              }`
            }
          >
            <Icon size={17} />
            {label}
          </NavLink>
        ))}
      </nav>

      <div className="p-3 text-[11px] text-gray-500 border-t border-border">
        Binance Futures · v1.0
      </div>
    </aside>
  );
}
