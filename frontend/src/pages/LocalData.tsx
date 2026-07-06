import { useEffect, useMemo, useState } from "react";
import { HardDrive, Download } from "lucide-react";
import { toast } from "sonner";
import { api } from "../api/client";
import Chart from "../components/Chart";

/**
 * Xem dữ liệu 1m LOCAL (các file parquet trong thư mục /1m) trên chart.
 * Mỗi symbol có ~4 năm nến 1m (~2 triệu nến) nên không vẽ hết cùng lúc:
 *  - Mặc định khung 1d -> thấy ngay toàn bộ lịch sử.
 *  - Đổi khung + chọn khoảng ngày để zoom vào chi tiết (kể cả 1m).
 */

const fmtDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);
// yyyy-mm-dd (input) -> ms UTC; +1 ngày cho mốc "đến" để bao trọn ngày đó
const dayToMs = (d: string, endOfDay = false) => {
  if (!d) return undefined;
  const ms = Date.parse(d + "T00:00:00Z");
  if (isNaN(ms)) return undefined;
  return endOfDay ? ms + 24 * 60 * 60 * 1000 : ms;
};

export default function LocalData() {
  const [symbols, setSymbols] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<string | null>(null);

  const [interval, setInterval] = useState("1d");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [range, setRange] = useState<{ minTs: number; maxTs: number } | null>(null);
  const [flagged, setFlagged] = useState<{ symbol: string; maxZeroRun: number }[]>([]);

  // ----- Tải dữ liệu 1m từ Binance -----
  const [majors, setMajors] = useState<{ symbol: string; present: boolean }[]>([]);
  const [dlInput, setDlInput] = useState("");
  const [dl, setDl] = useState<{ done: number; total: number; symbol?: string; status: string; note?: string } | null>(null);
  const dlRunning = dl?.status === "running";

  const refreshSymbols = () => {
    api.getLocalSymbols().then(({ symbols }) => setSymbols(symbols)).catch(() => {});
    api.getMajorsStatus().then((d) => setMajors(d.majors)).catch(() => {});
  };

  useEffect(() => {
    api
      .getLocalSymbols()
      .then(({ symbols }) => {
        setSymbols(symbols);
        setSelected((cur) => cur ?? symbols[0] ?? null);
      })
      .catch(() => setSymbols([]))
      .finally(() => setLoading(false));
    api
      .getLocalFlagged()
      .then(({ flagged }) => setFlagged(flagged))
      .catch(() => setFlagged([]));
    api.getMajorsStatus().then((d) => setMajors(d.majors)).catch(() => {});
  }, []);

  const startDownload = async (list: string[]) => {
    const syms = [...new Set(list.map((s) => s.trim().toUpperCase()).filter(Boolean))];
    if (!syms.length) return toast.error("Nhập ít nhất 1 symbol");
    setDl({ done: 0, total: syms.length, status: "running" });
    try {
      const { jobId, total } = await api.downloadData({ symbols: syms });
      setDl({ done: 0, total, status: "running" });
      const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
      for (let i = 0; i < 100000; i++) {
        const job = await api.getBacktestJob(jobId);
        setDl({ done: job.progress, total: job.total, symbol: job.currentSymbol, status: job.status, note: job.note });
        if (job.status === "done") {
          toast.success(job.note ?? "Tải xong");
          refreshSymbols();
          break;
        }
        if (job.status === "error") {
          toast.error(job.error ?? "Tải lỗi");
          break;
        }
        await sleep(1500);
      }
    } catch (e: any) {
      toast.error(e?.response?.data?.message ?? "Tải thất bại");
      setDl(null);
    }
  };

  const missingMajors = majors.filter((m) => !m.present).map((m) => m.symbol);

  // Lấy khoảng thời gian có sẵn của symbol đang chọn (để hiển thị + gợi ý)
  useEffect(() => {
    if (!selected) return;
    setRange(null);
    setFromDate("");
    setToDate("");
    api.getLocalSymbolRange(selected).then(setRange).catch(() => setRange(null));
  }, [selected]);

  const filtered = useMemo(() => {
    const q = search.trim().toUpperCase();
    const list = q ? symbols.filter((s) => s.includes(q)) : symbols;
    return list.slice(0, 300);
  }, [symbols, search]);

  const from = dayToMs(fromDate);
  const to = dayToMs(toDate, true);

  const INTERVALS = ["1m", "15m", "1h", "4h", "1d"];

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <HardDrive size={22} className="text-accent" />
        <div>
          <h1 className="text-xl font-bold">Dữ liệu Local (1m)</h1>
          <p className="text-xs text-gray-400">
            {loading ? "Đang tải danh sách..." : `${symbols.length} symbol có sẵn`}
            {flagged.length > 0 && (
              <span
                className="text-amber-400/80 ml-1 cursor-help"
                title={
                  "Đã ẩn (dữ liệu flatline/chết):\n" +
                  flagged.map((f) => `${f.symbol} — ${f.maxZeroRun} ngày vol=0`).join("\n")
                }
              >
                · đã ẩn {flagged.length} coin dữ liệu xấu ⓘ
              </span>
            )}
          </p>
        </div>
      </div>

      {/* ===== Tải dữ liệu 1m từ Binance (Futures USDT-M) ===== */}
      <div className="card space-y-3">
        <div className="flex items-center gap-2">
          <Download size={16} className="text-accent" />
          <span className="text-xs text-accent uppercase font-semibold">Kéo dữ liệu 1m từ Binance (Futures USDT-M)</span>
        </div>

        {/* Majors: đã có / còn thiếu */}
        {majors.length > 0 && (
          <div className="space-y-1.5">
            <div className="text-[11px] text-gray-400 uppercase">Rổ Majors ({majors.filter((m) => m.present).length}/{majors.length} đã có)</div>
            <div className="flex flex-wrap gap-1.5">
              {majors.map((m) => (
                <span
                  key={m.symbol}
                  className={`px-2 py-0.5 rounded text-xs border ${m.present ? "border-up/40 text-up bg-up/10" : "border-down/40 text-down bg-down/10"}`}
                  title={m.present ? "Đã có trong /1m" : "Chưa có — bấm tải"}
                >
                  {m.present ? "✓ " : "• "}{m.symbol}
                </span>
              ))}
            </div>
          </div>
        )}

        <div className="flex flex-wrap items-end gap-2">
          <button
            className="btn btn-primary"
            onClick={() => startDownload(missingMajors)}
            disabled={dlRunning || missingMajors.length === 0}
            title="Kéo full lịch sử 1m các majors còn thiếu (gồm BTC/ETH) vào /1m"
          >
            ⬇ Tải {missingMajors.length} majors còn thiếu
          </button>
          <div className="flex-1 min-w-[240px]">
            <label className="text-xs text-gray-400 uppercase">Hoặc nhập symbol tự chọn</label>
            <input
              className="input mt-1"
              placeholder="VD: BTCUSDT, ETHUSDT, SOLUSDT"
              value={dlInput}
              onChange={(e) => setDlInput(e.target.value)}
              disabled={dlRunning}
            />
          </div>
          <button
            className="btn btn-ghost"
            onClick={() => startDownload(dlInput.split(/[\s,]+/))}
            disabled={dlRunning || !dlInput.trim()}
          >
            ⬇ Tải danh sách
          </button>
        </div>

        {dl && (
          <div className="space-y-1">
            <div className="flex justify-between text-xs text-gray-400">
              <span>
                {dl.status === "done" ? "✓ " : ""}
                {dl.done}/{dl.total} symbol{dl.symbol ? ` · ${dl.symbol}` : ""}
                {dl.note ? ` · ${dl.note}` : ""}
              </span>
              <span>{dl.total ? Math.round((dl.done / dl.total) * 100) : 0}%</span>
            </div>
            <div className="w-full h-2 bg-panel2 rounded overflow-hidden">
              <div className="h-full bg-accent transition-all" style={{ width: `${dl.total ? (dl.done / dl.total) * 100 : 0}%` }} />
            </div>
          </div>
        )}
        <p className="text-[11px] text-gray-500">
          Kéo FULL lịch sử nến 1m (từ ~2019) và lưu parquet vào <code>/1m</code> (cùng định dạng dataset hiện có) →
          tự xuất hiện trong danh sách, chart và backtest. Full 1 coin ~vài phút (hàng triệu nến qua REST).
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[260px_1fr] gap-4">
        {/* Cột trái: tìm + danh sách symbol */}
        <div className="card p-3 flex flex-col gap-3 lg:h-[560px]">
          <input
            className="input"
            placeholder="Tìm symbol... (vd ADA)"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <div className="flex-1 overflow-y-auto -mx-1 px-1 space-y-1 max-h-[240px] lg:max-h-none">
            {filtered.map((s) => (
              <button
                key={s}
                onClick={() => setSelected(s)}
                className={`w-full text-left px-3 py-1.5 rounded text-sm truncate ${
                  selected === s
                    ? "bg-panel2 text-accent border border-border"
                    : "text-gray-300 hover:bg-panel2"
                }`}
              >
                {s}
              </button>
            ))}
            {!loading && filtered.length === 0 && (
              <div className="text-xs text-gray-500 px-3 py-2">Không tìm thấy symbol.</div>
            )}
          </div>
        </div>

        {/* Cột phải: điều khiển + chart */}
        <div className="min-w-0 space-y-3">
          {selected ? (
            <>
              {/* Thanh điều khiển: khung + khoảng ngày */}
              <div className="card p-3 flex flex-wrap items-end gap-x-4 gap-y-3">
                <div>
                  <div className="text-xs text-gray-400 mb-1">Khung</div>
                  <div className="flex overflow-hidden rounded border border-border">
                    {INTERVALS.map((tf) => (
                      <button
                        key={tf}
                        onClick={() => setInterval(tf)}
                        className={`px-2.5 py-1 text-xs transition-colors ${
                          interval === tf
                            ? "bg-accent text-black font-semibold"
                            : "text-gray-300 hover:bg-panel2"
                        }`}
                      >
                        {tf}
                      </button>
                    ))}
                  </div>
                </div>

                <div>
                  <div className="text-xs text-gray-400 mb-1">Từ ngày</div>
                  <input
                    type="date"
                    className="input py-1"
                    value={fromDate}
                    min={range ? fmtDate(range.minTs) : undefined}
                    max={range ? fmtDate(range.maxTs) : undefined}
                    onChange={(e) => setFromDate(e.target.value)}
                  />
                </div>
                <div>
                  <div className="text-xs text-gray-400 mb-1">Đến ngày</div>
                  <input
                    type="date"
                    className="input py-1"
                    value={toDate}
                    min={range ? fmtDate(range.minTs) : undefined}
                    max={range ? fmtDate(range.maxTs) : undefined}
                    onChange={(e) => setToDate(e.target.value)}
                  />
                </div>
                {(fromDate || toDate) && (
                  <button
                    className="text-xs text-gray-400 hover:text-gray-200 underline py-1.5"
                    onClick={() => {
                      setFromDate("");
                      setToDate("");
                    }}
                  >
                    Xóa lọc
                  </button>
                )}

                <div className="text-[11px] text-gray-500 ml-auto self-center">
                  {range
                    ? `Dữ liệu: ${fmtDate(range.minTs)} → ${fmtDate(range.maxTs)}`
                    : "Đang đọc khoảng dữ liệu..."}
                </div>
              </div>

              {interval === "1m" && !fromDate && !toDate && (
                <div className="text-[11px] text-amber-400/90">
                  ⚠️ Khung 1m rất nhiều nến — đang hiển thị đoạn gần nhất. Chọn khoảng ngày để xem
                  giai đoạn cụ thể.
                </div>
              )}

              <Chart
                key={selected + interval}
                symbol={selected}
                local
                defaultInterval={interval}
                limit={20000}
                from={from}
                to={to}
                hideIntervalSwitch
              />
            </>
          ) : (
            <div className="card p-8 text-center text-gray-500">
              {loading ? "Đang tải..." : "Không có dữ liệu local. Kiểm tra thư mục /1m."}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
