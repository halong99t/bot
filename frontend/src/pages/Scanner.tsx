import { useEffect, useMemo, useState } from "react";
import { api } from "../api/client";
import type { MarketData } from "../types";
import Chart from "../components/Chart";

type SortKey = "priceChange24h" | "quoteVolume" | "fundingRate" | "openInterest" | "rsi";

function fmt(n: number | null | undefined, d = 2) {
  if (n === null || n === undefined) return "—";
  return n.toLocaleString("en-US", { maximumFractionDigits: d });
}

export default function Scanner() {
  const [coins, setCoins] = useState<MarketData[]>([]);
  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("quoteVolume");
  const [desc, setDesc] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);
  const [onlyGainers, setOnlyGainers] = useState(false);

  useEffect(() => {
    const load = () => api.getCoins().then(setCoins).catch(() => {});
    load();
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, []);

  const rows = useMemo(() => {
    let r = coins.filter((c) => c.symbol.toLowerCase().includes(search.toLowerCase()));
    if (onlyGainers) r = r.filter((c) => c.priceChange24h > 0);
    r = [...r].sort((a, b) => {
      const av = (a[sortKey] ?? 0) as number;
      const bv = (b[sortKey] ?? 0) as number;
      return desc ? bv - av : av - bv;
    });
    return r;
  }, [coins, search, sortKey, desc, onlyGainers]);

  const toggleSort = (k: SortKey) => {
    if (k === sortKey) setDesc((d) => !d);
    else {
      setSortKey(k);
      setDesc(true);
    }
  };

  const Th = ({ k, label }: { k: SortKey; label: string }) => (
    <th className="th cursor-pointer select-none" onClick={() => toggleSort(k)}>
      {label} {sortKey === k ? (desc ? "↓" : "↑") : ""}
    </th>
  );

  return (
    <div className="space-y-4">
      <h2 className="text-xl font-bold">Market Scanner</h2>

      <div className="flex flex-wrap gap-3 items-center">
        <input
          className="input max-w-xs"
          placeholder="Tìm symbol... (vd BTC)"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <label className="flex items-center gap-2 text-sm text-gray-300">
          <input
            type="checkbox"
            checked={onlyGainers}
            onChange={(e) => setOnlyGainers(e.target.checked)}
          />
          Chỉ coin tăng
        </label>
        <span className="text-xs text-gray-400">{rows.length} coin</span>
      </div>

      {selected && (
        <Chart symbol={selected} />
      )}

      <div className="card overflow-x-auto p-0">
        <table className="w-full min-w-[820px]">
          <thead>
            <tr>
              <th className="th">Symbol</th>
              <th className="th">Giá</th>
              <Th k="priceChange24h" label="24h %" />
              <Th k="quoteVolume" label="Volume (USDT)" />
              <Th k="fundingRate" label="Funding" />
              <Th k="openInterest" label="OI" />
              <Th k="rsi" label="RSI" />
              <th className="th">EMA20/50/200</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => (
              <tr
                key={c.symbol}
                className="hover:bg-panel2 cursor-pointer"
                onClick={() => setSelected(c.symbol)}
              >
                <td className="td font-medium">{c.symbol}</td>
                <td className="td">{fmt(c.price, 6)}</td>
                <td className={`td ${c.priceChange24h >= 0 ? "text-up" : "text-down"}`}>
                  {c.priceChange24h >= 0 ? "+" : ""}
                  {fmt(c.priceChange24h)}%
                </td>
                <td className="td">{fmt(c.quoteVolume, 0)}</td>
                <td
                  className={`td ${
                    (c.fundingRate ?? 0) >= 0 ? "text-up" : "text-down"
                  }`}
                >
                  {c.fundingRate !== null ? (c.fundingRate * 100).toFixed(4) + "%" : "—"}
                </td>
                <td className="td">{fmt(c.openInterest, 0)}</td>
                <td className="td">{fmt(c.rsi, 1)}</td>
                <td className="td text-xs text-gray-400">
                  {fmt(c.ema20, 4)} / {fmt(c.ema50, 4)} / {fmt(c.ema200, 4)}
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td className="td text-gray-500" colSpan={8}>
                  Chưa có dữ liệu — chờ bot scan chu kỳ đầu tiên...
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
