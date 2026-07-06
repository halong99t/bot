import { useState, Fragment, type ReactNode } from "react";
import Tooltip from "./Tooltip";
import type { BacktestResult, GroupStat } from "../types";

const REASON_LABEL: Record<string, string> = {
  TP: "Chốt lời (TP)",
  SL: "Cắt lỗ (SL)",
  TRAIL: "Trailing (Chandelier)",
  DONCHIAN: "Thủng kênh Donchian",
  TIME: "Time-stop",
  FLIP: "Đảo chiều (Flip)",
  LIQ: "Thanh lý (LIQ)",
  EOD: "Hết dữ liệu (EOD)",
};
const reasonCls = (r: string) =>
  r === "TP"
    ? "text-up"
    : r === "SL" || r === "LIQ"
    ? "text-down"
    : r === "TRAIL" || r === "DONCHIAN"
    ? "text-accent"
    : r === "FLIP" || r === "TIME"
    ? "text-yellow-400"
    : "text-gray-300";
const STATE_ALIGN: Record<string, string> = {
  LONG1: "MOMENTUM",
  SHORT1: "MOMENTUM",
  LONG2: "PULLBACK",
  SHORT2: "PULLBACK",
  LONG3: "REVERSAL",
  SHORT3: "REVERSAL",
};

// Định dạng ngày + giờ:phút (theo locale của máy)
const fmtDT = (ts: number) =>
  `${new Date(ts).toLocaleDateString()} ${new Date(ts).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  })}`;
// Giá: nhiều chữ số thập phân cho coin giá nhỏ
const fmtPrice = (n: number) =>
  n >= 1 ? n.toLocaleString(undefined, { maximumFractionDigits: 4 }) : Number(n.toPrecision(4)).toString();
// "2026-03" -> "T3/2026"
const fmtMonth = (ym: string) => {
  const [y, m] = ym.split("-");
  return `T${Number(m)}/${y}`;
};

function Stat({
  label,
  value,
  accent,
  hint,
}: {
  label: string;
  value: string;
  accent?: string;
  hint?: string;
}) {
  return (
    <div className="card">
      <div className="text-xs text-gray-400 uppercase flex items-center">
        {label}
        {hint ? (
          <Tooltip text={hint}>
            <span className="ml-1 text-gray-500 cursor-help">ⓘ</span>
          </Tooltip>
        ) : null}
      </div>
      <div className={`text-xl font-bold mt-1 ${accent ?? ""}`}>{value}</div>
    </div>
  );
}

/** Đường equity dạng SVG sparkline. baseline = mức tham chiếu (0 hoặc vốn ban đầu) */
function EquityCurve({ data, baseline = 0 }: { data: number[]; baseline?: number }) {
  if (data.length < 2)
    return <div className="text-gray-500 text-sm">Không đủ dữ liệu để vẽ đường equity.</div>;
  const w = 800;
  const h = 200;
  const min = Math.min(baseline, ...data);
  const max = Math.max(baseline, ...data);
  const range = max - min || 1;
  const pts = data
    .map((v, i) => {
      const x = (i / (data.length - 1)) * w;
      const y = h - ((v - min) / range) * h;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  const baseY = h - ((baseline - min) / range) * h;
  const last = data[data.length - 1];

  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="w-full h-52" preserveAspectRatio="none">
      <line x1="0" y1={baseY} x2={w} y2={baseY} stroke="#2b3139" strokeWidth="1" />
      <polyline
        points={pts}
        fill="none"
        stroke={last >= baseline ? "#0ecb81" : "#f6465d"}
        strokeWidth="2"
      />
    </svg>
  );
}

/** Bảng thống kê gộp theo nhóm (kiểu thoát / state / alignment). */
function GroupTable({
  title,
  subtitle,
  label,
  rows,
  renderKey,
}: {
  title: string;
  subtitle?: string;
  label: string;
  rows: GroupStat[];
  renderKey: (key: string) => ReactNode;
}) {
  return (
    <div className="card overflow-x-auto p-0">
      <div className="px-3 py-2 font-semibold border-b border-border">
        {title}
        {subtitle ? <span className="text-xs text-gray-500 font-normal"> {subtitle}</span> : null}
      </div>
      <table className="resp-table w-full min-w-[480px]">
        <thead>
          <tr>
            <th className="th">{label}</th>
            <th className="th">Lệnh</th>
            <th className="th">Win / Loss</th>
            <th className="th">Win %</th>
            <th className="th">TB %/lệnh</th>
            <th className="th">Tổng %</th>
            <th className="th">PNL USDT</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((g) => (
            <tr key={g.key} className="hover:bg-panel2">
              <td className="td font-medium" data-label={label}>{renderKey(g.key)}</td>
              <td className="td" data-label="Lệnh">{g.trades}</td>
              <td className="td" data-label="Win / Loss">
                <span className="text-up">{g.wins}</span>
                {" / "}
                <span className="text-down">{g.losses}</span>
              </td>
              <td className={`td ${g.winRate >= 50 ? "text-up" : "text-down"}`} data-label="Win %">
                {g.winRate.toFixed(1)}%
              </td>
              <td className={`td ${g.avgReturnPct >= 0 ? "text-up" : "text-down"}`} data-label="TB %/lệnh">
                {g.avgReturnPct >= 0 ? "+" : ""}
                {g.avgReturnPct.toFixed(2)}%
              </td>
              <td className={`td ${g.returnPct >= 0 ? "text-up" : "text-down"}`} data-label="Tổng %">
                {g.returnPct >= 0 ? "+" : ""}
                {g.returnPct.toFixed(2)}%
              </td>
              <td className={`td font-medium ${g.pnlUsdt >= 0 ? "text-up" : "text-down"}`} data-label="PNL USDT">
                {g.pnlUsdt >= 0 ? "+" : ""}
                {g.pnlUsdt.toLocaleString()} $
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Hiển thị kết quả 1 lần backtest (dùng chung cho trang Backtest chiến lược LONG và trang EMA).
 * emptyHint: gợi ý hiển thị khi 0 lệnh khớp (mỗi trang có gợi ý riêng).
 */
export default function BacktestResults({
  result,
  emptyHint,
}: {
  result: BacktestResult;
  emptyHint?: ReactNode;
}) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const toggleSymbol = (sym: string) => setCollapsed((c) => ({ ...c, [sym]: !c[sym] }));
  const [showBlowup, setShowBlowup] = useState(false);

  if (result.totalTrades === 0) {
    return (
      <div className="card border-accent/40">
        <div className="font-semibold text-accent mb-1">
          ⚠ [{result.params.interval}] Đã quét xong nhưng 0 lệnh khớp
        </div>
        <p className="text-sm text-gray-300">
          Đã quét {result.perSymbol.reduce((s, x) => s + x.candles, 0).toLocaleString()} nến trên{" "}
          {result.symbolsTested.length} symbol.{" "}
          {emptyHint ?? "Điều kiện vào lệnh quá chặt cho khung này — nới tham số rồi chạy lại."}
        </p>
      </div>
    );
  }

  return (
    <>
      <div className="card border-accent/30 text-sm flex flex-wrap gap-x-6 gap-y-1">
        <span>
          Chi tiết khung: <b className="text-accent">{result.params.interval}</b>
        </span>
        <span>
          Trần đồng thời: <b className="text-accent">{result.maxConcurrentPositions}</b>
        </span>
        <span>
          Tổng tín hiệu: <b>{result.candidateTrades}</b>
        </span>
        <span>
          Đã nhận: <b className="text-up">{result.totalTrades}</b>
        </span>
        <span>
          Bỏ vì chạm trần: <b className="text-down">{result.skippedByCap}</b>
        </span>
        <span>
          Đỉnh vị thế mở: <b>{result.peakConcurrent}</b>
        </span>
        <span>
          Ký quỹ:{" "}
          <b className="text-accent">{result.marginMode === "ISOLATED" ? "Isolated" : "Cross"}</b>
        </span>
        <span>
          TP/SL:{" "}
          <b className="text-accent">
            {result.tpSlMode === "MARGIN" ? "theo margin (ROI)" : "theo giá"}
          </b>
        </span>
        {result.marginMode === "ISOLATED" && (
          <span>
            Cháy lệnh: <b className="text-down">{result.liquidations}</b> (giá ↓{" "}
            {Math.abs(result.liqPriceMovePct)}%)
          </span>
        )}
      </div>

      {result.accountBlown && (
        <div className="card border-down/60 bg-down/10">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div className="font-semibold text-down">
              💥 Cháy tài khoản sau {result.blownAtTrade} lệnh — mất sạch vốn (ROI −100%)
            </div>
            {result.blowupTrades && result.blowupTrades.length > 0 && (
              <button className="btn btn-ghost text-xs px-2 py-1" onClick={() => setShowBlowup(true)}>
                Xem chi tiết lệnh làm cháy →
              </button>
            )}
          </div>
          <p className="text-sm text-gray-300 mt-1">
            Đòn bẩy {result.leverage}x quá cao so với chuỗi lệnh thua. Hãy giảm đòn bẩy, giảm tiền
            mỗi lệnh, hoặc dùng chế độ <b>Isolated</b> để giới hạn lỗ mỗi lệnh.
          </p>
        </div>
      )}

      {/* Popup: chuỗi lệnh kéo tài khoản về 0 */}
      {showBlowup && result.blowupTrades && result.blowupTrades.length > 0 && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/70" onClick={() => setShowBlowup(false)} />
          <div className="relative card w-full max-w-3xl max-h-[85vh] overflow-y-auto">
            <div className="flex items-center justify-between gap-2 mb-1">
              <h3 className="font-semibold text-down">
                💥 Chuỗi lệnh kéo tài khoản về $0 (cháy ở lệnh #{result.blownAtTrade})
              </h3>
              <button
                onClick={() => setShowBlowup(false)}
                className="text-gray-400 hover:text-gray-200 text-xl leading-none"
                aria-label="Đóng"
              >
                ✕
              </button>
            </div>
            <p className="text-[11px] text-gray-400 mb-3">
              {result.blowupTrades.length} lệnh cuối (theo thứ tự ĐÓNG lệnh). Cột “Số dư sau” là số dư
              sau khi đóng lệnh đó — lệnh cuối cùng đưa về $0.
            </p>
            <div className="overflow-x-auto">
              <table className="resp-table w-full min-w-[640px]">
                <thead>
                  <tr>
                    <th className="th">#</th>
                    <th className="th">Symbol</th>
                    <th className="th">Đóng lúc</th>
                    <th className="th">Lý do</th>
                    <th className="th">PNL USDT</th>
                    <th className="th">Số dư trước</th>
                    <th className="th">Số dư sau</th>
                  </tr>
                </thead>
                <tbody>
                  {result.blowupTrades.map((t, i) => {
                    const isLast = i === result.blowupTrades!.length - 1;
                    return (
                      <tr key={t.seq} className={isLast ? "bg-down/15" : "hover:bg-panel2"}>
                        <td className="td text-gray-500" data-label="#">{t.seq}</td>
                        <td className="td font-medium" data-label="Symbol">
                          {t.symbol}
                          {t.state ? <span className="text-xs text-accent ml-1">{t.state}</span> : null}
                        </td>
                        <td className="td text-xs text-gray-300 whitespace-nowrap" data-label="Đóng lúc">
                          {fmtDT(t.exitTime)}
                        </td>
                        <td className="td" data-label="Lý do">
                          <span className={`text-xs px-2 py-0.5 rounded ${reasonCls(t.reason)} bg-panel2`}>
                            {t.reason}
                          </span>
                        </td>
                        <td className={`td ${t.pnlUsdt >= 0 ? "text-up" : "text-down"}`} data-label="PNL USDT">
                          {t.pnlUsdt >= 0 ? "+" : ""}
                          {t.pnlUsdt.toFixed(2)}
                        </td>
                        <td className="td text-gray-400" data-label="Số dư trước">
                          {t.balanceBefore.toLocaleString()}
                        </td>
                        <td
                          className={`td font-medium ${isLast ? "text-down" : "text-gray-200"}`}
                          data-label="Số dư sau"
                        >
                          {t.balanceAfter.toLocaleString()}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="mt-3 text-right">
              <button className="btn btn-ghost" onClick={() => setShowBlowup(false)}>
                Đóng
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ===== Lệnh cháy / thanh lý ===== */}
      {result.liquidations > 0 &&
        (() => {
          const liq = result.trades.filter((t) => t.reason === "LIQ");
          const hasState = liq.some((t) => t.state);
          return (
            <div className="card border-down/40 overflow-x-auto p-0">
              <div className="px-3 py-2 font-semibold border-b border-border text-down">
                💥 Lệnh cháy (thanh lý) — {result.liquidations} lệnh
                {liq.length < result.liquidations ? (
                  <span className="text-xs text-gray-400 font-normal"> (hiển thị {liq.length})</span>
                ) : null}
              </div>
              <p className="px-3 py-2 text-[11px] text-gray-400 border-b border-border">
                <b>Lý do cháy:</b> chế độ <b>Isolated</b>, đòn bẩy <b>{result.leverage}x</b> → khi giá
                đi ngược ~<b>{Math.abs(result.liqPriceMovePct)}%</b> (= 100 ÷ đòn bẩy) là mất sạch ký
                quỹ của lệnh, bị thanh lý <b>trước khi</b> chạm SL. Giảm đòn bẩy hoặc nới SL để tránh.
              </p>
              {liq.length === 0 ? (
                <p className="px-3 py-2 text-xs text-gray-500">
                  (Các lệnh cháy không nằm trong {result.trades.length} lệnh hiển thị đầu tiên.)
                </p>
              ) : (
                <table className="resp-table w-full min-w-[720px]">
                  <thead>
                    <tr>
                      <th className="th">Symbol</th>
                      {hasState && <th className="th">State</th>}
                      <th className="th">Thời gian vào</th>
                      <th className="th">Thời gian cháy</th>
                      <th className="th">Giá vào</th>
                      <th className="th">Giá thanh lý</th>
                      <th className="th">Nến giữ</th>
                      <th className="th">Biến động %</th>
                      <th className="th">PNL USDT</th>
                    </tr>
                  </thead>
                  <tbody>
                    {liq.map((t, i) => (
                      <tr key={i} className="hover:bg-panel2">
                        <td className="td font-medium" data-label="Symbol">{t.symbol}</td>
                        {hasState && (
                          <td className="td" data-label="State">
                            <span className="text-accent">{t.state}</span>
                          </td>
                        )}
                        <td className="td text-xs text-gray-300 whitespace-nowrap" data-label="Vào">
                          {fmtDT(t.entryTime)}
                        </td>
                        <td className="td text-xs text-gray-300 whitespace-nowrap" data-label="Cháy">
                          {fmtDT(t.exitTime)}
                        </td>
                        <td className="td text-xs" data-label="Giá vào">{fmtPrice(t.entryPrice)}</td>
                        <td className="td text-xs text-down" data-label="Giá thanh lý">{fmtPrice(t.exitPrice)}</td>
                        <td className="td text-gray-400" data-label="Nến giữ">{t.barsHeld}</td>
                        <td className="td text-down" data-label="Biến động %">{t.pnlPct.toFixed(2)}%</td>
                        <td className="td text-down" data-label="PNL USDT">{t.pnlUsdt.toFixed(2)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          );
        })()}

      {/* ===== Kết quả theo TIỀN ===== */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Stat label="Vốn ban đầu" value={`${result.initialCapitalUsdt.toLocaleString()} USDT`} />
        <Stat
          label="Số dư cuối"
          value={`${result.finalBalanceUsdt.toLocaleString()} USDT`}
          accent={result.finalBalanceUsdt >= result.initialCapitalUsdt ? "text-up" : "text-down"}
        />
        <Stat
          label="Tổng lãi/lỗ"
          value={`${result.totalPnlUsdt >= 0 ? "+" : ""}${result.totalPnlUsdt.toLocaleString()} USDT`}
          accent={result.totalPnlUsdt >= 0 ? "text-up" : "text-down"}
        />
        <Stat
          label="ROI tài khoản ⭐"
          value={`${result.roiPct >= 0 ? "+" : ""}${result.roiPct}%`}
          accent={result.roiPct >= 0 ? "text-up" : "text-down"}
          hint="LỜI THẬT của tài khoản = (số dư cuối − vốn ban đầu) ÷ vốn ban đầu. Đây là con số cần nhìn (khớp với Số dư cuối), KHÔNG phải 'Tổng % lệnh'."
        />
      </div>

      <div className="card">
        <div className="flex items-center justify-between mb-2">
          <h3 className="font-semibold">Số dư tài khoản (USDT) — {result.params.interval}</h3>
          <span className="text-xs text-gray-400 flex items-center">
            {(() => {
              const peak = Math.max(result.initialCapitalUsdt, ...result.equityCurveUsdt);
              const ddPct = peak > 0 ? (result.maxDrawdownUsdt / peak) * 100 : 0;
              return `Max drawdown: ${result.maxDrawdownUsdt}$ (${ddPct.toFixed(1)}% từ đỉnh ${peak.toLocaleString()}$)`;
            })()}
            <Tooltip text="Mức sụt sâu nhất từ ĐỈNH số dư xuống ĐÁY sau đó (tính bằng tiền). Không phải lỗ tổng — đo 'cú đau' lớn nhất khi chạy chiến lược. Có thể lớn hơn vốn ban đầu nếu tài khoản đã tăng cao rồi rớt.">
              <span className="ml-1 text-gray-500 cursor-help">ⓘ</span>
            </Tooltip>
          </span>
        </div>
        <EquityCurve data={result.equityCurveUsdt} baseline={result.initialCapitalUsdt} />
      </div>

      {/* ===== Kết quả theo % ===== */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Stat label="Tổng lệnh" value={String(result.totalTrades)} />
        <Stat
          label="Win rate"
          value={`${result.winRate.toFixed(1)}%`}
          accent={result.winRate >= 50 ? "text-up" : "text-down"}
          hint="Tỷ lệ lệnh có lãi trên tổng số lệnh. Lệnh bị thanh lý (LIQ) tính là thua."
        />
        <Stat
          label="Tổng % lệnh (Σ giá)"
          value={`${result.totalReturnPct >= 0 ? "+" : ""}${result.totalReturnPct}%`}
          accent={result.totalReturnPct >= 0 ? "text-up" : "text-down"}
          hint="Tổng % BIẾN ĐỘNG GIÁ cộng dồn của tất cả lệnh (Σ pnlPct) — KHÔNG phải lời tài khoản. Với sizing R-based (rủi ro nhỏ mỗi lệnh), số này thường lớn hơn ROI nhiều. Lời tài khoản THẬT xem ở 'ROI' và 'Số dư cuối'."
        />
        <Stat
          label="Max drawdown"
          value={`${result.maxDrawdownPct}%`}
          accent="text-down"
          hint="Mức sụt giảm sâu nhất của đường lợi nhuận cộng dồn so với đỉnh trước đó — đo độ 'đau' tối đa khi chạy chiến lược."
        />
        <Stat
          label="Profit factor"
          value={(result.profitFactor ?? 0) >= 999 ? "∞" : `${(result.profitFactor ?? 0).toFixed(2)}`}
          accent={(result.profitFactor ?? 0) >= 1 ? "text-up" : "text-down"}
          hint="Tổng % lãi chia tổng % lỗ (gross). >1 = có lãi; ≥1.5 là tốt."
        />
        <Stat
          label="Sharpe"
          value={`${(result.sharpe ?? 0).toFixed(2)}`}
          accent={(result.sharpe ?? 0) > 0 ? "text-up" : "text-down"}
          hint="Trung bình / độ lệch chuẩn % lãi lỗ mỗi lệnh — đo lợi nhuận đã điều chỉnh theo rủi ro (càng cao càng ổn định)."
        />
        <Stat
          label="Expectancy"
          value={`${(result.expectancyR ?? 0) >= 0 ? "+" : ""}${(result.expectancyR ?? 0).toFixed(2)}R`}
          accent={(result.expectancyR ?? 0) > 0 ? "text-up" : "text-down"}
          hint="Kỳ vọng lãi/lỗ mỗi lệnh tính theo bội số R (R = khoảng cách entry→SL). +0.35R nghĩa là mỗi lệnh trung bình lãi 0.35 lần mức rủi ro."
        />
        <Stat
          label="Sortino"
          value={`${(result.sortino ?? 0).toFixed(2)}`}
          accent={(result.sortino ?? 0) > 0 ? "text-up" : "text-down"}
          hint="Như Sharpe nhưng chỉ phạt biến động GIẢM (downside). Cao hơn Sharpe là bình thường."
        />
        <Stat
          label="Calmar"
          value={`${(result.calmar ?? 0).toFixed(2)}`}
          accent={(result.calmar ?? 0) > 0 ? "text-up" : "text-down"}
          hint="CAGR / Max Drawdown — lợi nhuận kép hằng năm trên mỗi đơn vị drawdown. >1 là tốt."
        />
        <Stat
          label="CAGR"
          value={`${(result.cagr ?? 0) >= 0 ? "+" : ""}${(result.cagr ?? 0).toFixed(1)}%`}
          accent={(result.cagr ?? 0) >= 0 ? "text-up" : "text-down"}
          hint="Tăng trưởng kép hằng năm của equity (annualized theo khoảng thời gian backtest thực tế)."
        />
        <Stat
          label="Chuỗi thắng/thua"
          value={`${result.maxConsecutiveWins ?? 0}W · ${result.maxConsecutiveLosses ?? 0}L`}
          hint="Số lệnh thắng / thua liên tiếp dài nhất — đo mức độ 'chịu đựng' chuỗi thua."
        />
        <Stat
          label="TB giữ lệnh"
          value={`${(result.avgHoldingHours ?? 0) >= 24 ? `${((result.avgHoldingHours ?? 0) / 24).toFixed(1)}d` : `${(result.avgHoldingHours ?? 0).toFixed(1)}h`}`}
          hint="Thời gian giữ một lệnh trung bình (giờ/ngày thực), tính từ lúc vào đến lúc đóng."
        />
        <Stat
          label="TB mỗi lệnh"
          value={`${result.avgReturnPct}%`}
          hint="Lợi nhuận trung bình (theo % biến động giá) của mỗi lệnh."
        />
        <Stat label="Win lớn nhất" value={`${result.maxWinPct}%`} accent="text-up" />
        <Stat label="Loss lớn nhất" value={`${result.maxLossPct}%`} accent="text-down" />
        <Stat
          label="TB nến giữ"
          value={`${result.avgBarsHeld}`}
          hint="Số nến trung bình giữ một lệnh từ lúc vào đến lúc đóng (TP/SL/LIQ)."
        />
      </div>

      {/* ===== Kết quả theo THÁNG ===== */}
      {result.byMonth && result.byMonth.length > 0 && (
        <div className="card overflow-x-auto p-0">
          <div className="px-3 py-2 font-semibold border-b border-border">
            Theo tháng — {result.params.interval}{" "}
            <span className="text-xs text-gray-500 font-normal">
              (theo thời gian vào lệnh, giờ UTC)
            </span>
          </div>
          <table className="resp-table w-full min-w-[560px]">
            <thead>
              <tr>
                <th className="th">Tháng</th>
                <th className="th">Lệnh</th>
                <th className="th">Win / Loss</th>
                <th className="th">Win %</th>
                <th className="th">TB %/lệnh</th>
                <th className="th">Tổng %</th>
                <th className="th">PNL USDT</th>
              </tr>
            </thead>
            <tbody>
              {result.byMonth.map((m) => (
                <tr key={m.month} className="hover:bg-panel2">
                  <td className="td font-medium text-accent" data-label="Tháng">{fmtMonth(m.month)}</td>
                  <td className="td" data-label="Lệnh">{m.trades}</td>
                  <td className="td" data-label="Win / Loss">
                    <span className="text-up">{m.wins}</span>
                    {" / "}
                    <span className="text-down">{m.losses}</span>
                  </td>
                  <td className={`td ${m.winRate >= 50 ? "text-up" : "text-down"}`} data-label="Win %">
                    {m.winRate.toFixed(1)}%
                  </td>
                  <td className={`td ${m.avgReturnPct >= 0 ? "text-up" : "text-down"}`} data-label="TB %/lệnh">
                    {m.avgReturnPct >= 0 ? "+" : ""}
                    {m.avgReturnPct.toFixed(2)}%
                  </td>
                  <td className={`td ${m.returnPct >= 0 ? "text-up" : "text-down"}`} data-label="Tổng %">
                    {m.returnPct >= 0 ? "+" : ""}
                    {m.returnPct.toFixed(2)}%
                  </td>
                  <td className={`td font-medium ${m.pnlUsdt >= 0 ? "text-up" : "text-down"}`} data-label="PNL USDT">
                    {m.pnlUsdt >= 0 ? "+" : ""}
                    {m.pnlUsdt.toLocaleString()} $
                  </td>
                </tr>
              ))}
            </tbody>
            {result.byMonth.length > 1 && (
              <tfoot>
                <tr className="border-t border-border font-semibold">
                  <td className="td" data-label="Tháng">Tổng</td>
                  <td className="td" data-label="Lệnh">{result.byMonth.reduce((s, m) => s + m.trades, 0)}</td>
                  <td className="td" data-label="Win / Loss">
                    <span className="text-up">{result.byMonth.reduce((s, m) => s + m.wins, 0)}</span>
                    {" / "}
                    <span className="text-down">
                      {result.byMonth.reduce((s, m) => s + m.losses, 0)}
                    </span>
                  </td>
                  <td className="td" data-label="Win %">—</td>
                  <td className="td" data-label="TB %/lệnh">—</td>
                  <td className={`td ${result.totalReturnPct >= 0 ? "text-up" : "text-down"}`} data-label="Tổng %">
                    {result.totalReturnPct >= 0 ? "+" : ""}
                    {result.totalReturnPct.toFixed(2)}%
                  </td>
                  <td className={`td ${result.totalPnlUsdt >= 0 ? "text-up" : "text-down"}`} data-label="PNL USDT">
                    {result.totalPnlUsdt >= 0 ? "+" : ""}
                    {result.totalPnlUsdt.toLocaleString()} $
                  </td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      )}

      {/* ===== Kết quả theo NGÀY ===== */}
      {result.byDay && result.byDay.length > 0 && (() => {
        const days = result.byDay!;
        const spanDays = Math.max(1, Math.round((new Date(result.to).getTime() - new Date(result.from).getTime()) / 86400000));
        const covered = days.length;
        const covPct = Math.round((100 * covered) / spanDays);
        let maxGap = 0;
        for (let i = 1; i < days.length; i++) {
          const g = Math.round((new Date(days[i].day).getTime() - new Date(days[i - 1].day).getTime()) / 86400000);
          if (g > maxGap) maxGap = g;
        }
        const avgTrades = (days.reduce((s, d) => s + d.trades, 0) / covered).toFixed(1);
        return (
          <div className="card overflow-hidden p-0">
            <div className="px-3 py-2 font-semibold border-b border-border">
              Theo ngày{" "}
              <span className="text-xs text-gray-500 font-normal">(theo thời gian vào lệnh, giờ UTC)</span>
              <div className="text-xs font-normal mt-1">
                <span className={covPct >= 90 ? "text-up" : covPct >= 60 ? "text-yellow-400" : "text-down"}>
                  {covered}/{spanDays} ngày có lệnh ({covPct}%)
                </span>
                {" · "}TB <b>{avgTrades}</b> lệnh/ngày
                {" · "}khoảng trống dài nhất{" "}
                <span className={maxGap <= 1 ? "text-up" : maxGap <= 3 ? "text-yellow-400" : "text-down"}>{maxGap} ngày</span>
              </div>
            </div>
            <div className="max-h-80 overflow-y-auto">
              <table className="resp-table w-full min-w-[520px]">
                <thead className="sticky top-0 bg-panel">
                  <tr>
                    <th className="th">Ngày</th>
                    <th className="th">Lệnh</th>
                    <th className="th">Win / Loss</th>
                    <th className="th">Win %</th>
                    <th className="th">Tổng %</th>
                    <th className="th">PNL USDT</th>
                  </tr>
                </thead>
                <tbody>
                  {days.map((d) => (
                    <tr key={d.day} className="hover:bg-panel2">
                      <td className="td font-medium text-accent" data-label="Ngày">{d.day}</td>
                      <td className="td" data-label="Lệnh">{d.trades}</td>
                      <td className="td" data-label="Win / Loss">
                        <span className="text-up">{d.wins}</span>
                        {" / "}
                        <span className="text-down">{d.losses}</span>
                      </td>
                      <td className={`td ${d.winRate >= 50 ? "text-up" : "text-down"}`} data-label="Win %">{d.winRate.toFixed(0)}%</td>
                      <td className={`td ${d.returnPct >= 0 ? "text-up" : "text-down"}`} data-label="Tổng %">
                        {d.returnPct >= 0 ? "+" : ""}{d.returnPct.toFixed(2)}%
                      </td>
                      <td className={`td font-medium ${d.pnlUsdt >= 0 ? "text-up" : "text-down"}`} data-label="PNL USDT">
                        {d.pnlUsdt >= 0 ? "+" : ""}{d.pnlUsdt.toLocaleString()} $
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        );
      })()}

      {/* ===== Chia nhỏ theo từng chiến thuật cắt TP/SL ===== */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {result.byReason && result.byReason.length > 0 && (
          <GroupTable
            title="Theo kiểu thoát lệnh"
            subtitle="— cách 'cắt' TP/SL"
            label="Kiểu thoát"
            rows={result.byReason}
            renderKey={(k) => <span className={reasonCls(k)}>{REASON_LABEL[k] ?? k}</span>}
          />
        )}
        {result.byAlignment && result.byAlignment.length > 0 && (
          <GroupTable
            title="Theo chiến thuật (alignment)"
            subtitle="— mỗi alignment 1 công thức TP/SL"
            label="Alignment"
            rows={result.byAlignment}
            renderKey={(k) => <span className="text-accent">{k}</span>}
          />
        )}
      </div>
      {result.byState && result.byState.length > 0 && (
        <GroupTable
          title="Theo state EMA"
          subtitle="— 6 trạng thái · alignment"
          label="State"
          rows={result.byState}
          renderKey={(k) => (
            <span>
              <span className="text-accent">{k}</span>
              {STATE_ALIGN[k] ? (
                <span className="text-xs text-gray-400 ml-1">· {STATE_ALIGN[k]}</span>
              ) : null}
            </span>
          )}
        />
      )}

      {/* ===== Chi tiết lệnh theo symbol (gộp tổng hợp symbol + chi tiết) ===== */}
      <div className="card overflow-x-auto p-0">
        <div className="px-3 py-2 font-semibold border-b border-border flex items-center justify-between gap-2 flex-wrap">
          <span>
            Chi tiết lệnh theo symbol — {result.params.interval}{" "}
            <span className="text-xs text-gray-500 font-normal">
              (hiển thị {result.trades.length}
              {result.totalTrades > result.trades.length
                ? ` / ${result.totalTrades} lệnh`
                : " lệnh"}
              )
            </span>
          </span>
          <span className="flex gap-2">
            <button className="btn btn-ghost px-2 py-0.5 text-xs" onClick={() => setCollapsed({})}>
              Mở tất cả
            </button>
            <button
              className="btn btn-ghost px-2 py-0.5 text-xs"
              onClick={() =>
                setCollapsed(
                  Object.fromEntries(
                    result.perSymbol.filter((s) => s.trades > 0).map((s) => [s.symbol, true])
                  )
                )
              }
            >
              Thu gọn tất cả
            </button>
          </span>
        </div>
        <table className="resp-table w-full min-w-[860px]">
          <thead>
            <tr>
              <th className="th">Symbol / Thời gian vào</th>
              <th className="th">Thời gian đóng</th>
              <th className="th">Giá vào</th>
              <th className="th">Giá ra</th>
              <th className="th">Nến giữ</th>
              <th className="th">Lý do</th>
              <th className="th">PNL %</th>
              <th className="th">PNL USDT</th>
            </tr>
          </thead>
          <tbody>
            {(() => {
              // Gom lệnh hiển thị theo symbol
              const bySymbol = new Map<string, typeof result.trades>();
              result.trades.forEach((t) => {
                const arr = bySymbol.get(t.symbol) ?? [];
                arr.push(t);
                bySymbol.set(t.symbol, arr);
              });
              // Thứ tự symbol: theo return % giảm dần
              const groups = result.perSymbol
                .filter((s) => s.trades > 0)
                .sort((a, b) => b.returnPct - a.returnPct);
              return groups.map((s) => {
                const rows = bySymbol.get(s.symbol) ?? [];
                const isCollapsed = collapsed[s.symbol];
                const pnlUsdt = rows.reduce((sum, t) => sum + t.pnlUsdt, 0);
                return (
                  <Fragment key={s.symbol}>
                    {/* Dòng tiêu đề symbol = tổng hợp */}
                    <tr
                      className="bg-panel2/60 cursor-pointer hover:bg-panel2 border-t border-border"
                      onClick={() => toggleSymbol(s.symbol)}
                    >
                      <td className="td font-semibold" colSpan={5}>
                        <span className="text-gray-500 mr-1">{isCollapsed ? "▸" : "▾"}</span>
                        <span className="text-accent">{s.symbol}</span>
                        <span className="text-xs text-gray-400 font-normal ml-2">
                          {s.trades} lệnh · Win {s.wins}/{s.trades}
                          {rows.length < s.trades ? ` · hiển thị ${rows.length}` : ""}
                        </span>
                      </td>
                      <td className="td text-xs text-gray-400" data-label="">Tổng symbol</td>
                      <td className={`td font-semibold ${s.returnPct >= 0 ? "text-up" : "text-down"}`} data-label="Tổng %">
                        {s.returnPct >= 0 ? "+" : ""}
                        {s.returnPct.toFixed(1)}%
                      </td>
                      <td className={`td font-semibold ${pnlUsdt >= 0 ? "text-up" : "text-down"}`} data-label="PNL USDT">
                        {pnlUsdt >= 0 ? "+" : ""}
                        {pnlUsdt.toFixed(2)}
                      </td>
                    </tr>
                    {/* Các lệnh chi tiết của symbol */}
                    {!isCollapsed &&
                      rows.map((t, i) => (
                        <tr key={i} className="hover:bg-panel2">
                          <td className="td text-xs text-gray-300 whitespace-nowrap pl-6" data-label="Vào">
                            {fmtDT(t.entryTime)}
                          </td>
                          <td className="td text-xs text-gray-300 whitespace-nowrap" data-label="Đóng">
                            {fmtDT(t.exitTime)}
                          </td>
                          <td className="td text-xs" data-label="Giá vào">{fmtPrice(t.entryPrice)}</td>
                          <td className="td text-xs" data-label="Giá ra">{fmtPrice(t.exitPrice)}</td>
                          <td className="td text-gray-400" data-label="Nến giữ">{t.barsHeld}</td>
                          <td className="td" data-label="Lý do">
                            <span
                              className={`text-xs px-2 py-0.5 rounded ${
                                t.reason === "TP"
                                  ? "bg-up/20 text-up"
                                  : t.reason === "SL"
                                  ? "bg-down/20 text-down"
                                  : t.reason === "LIQ"
                                  ? "bg-down/40 text-down font-semibold"
                                  : t.reason === "TRAIL"
                                  ? "bg-accent/15 text-accent"
                                  : t.reason === "FLIP"
                                  ? "bg-yellow-500/15 text-yellow-400"
                                  : "bg-panel2 text-gray-300"
                              }`}
                            >
                              {t.reason}
                            </span>
                          </td>
                          <td className={`td ${t.pnlPct >= 0 ? "text-up" : "text-down"}`} data-label="PNL %">
                            {t.pnlPct >= 0 ? "+" : ""}
                            {t.pnlPct.toFixed(2)}%
                          </td>
                          <td className={`td ${t.pnlUsdt >= 0 ? "text-up" : "text-down"}`} data-label="PNL USDT">
                            {t.pnlUsdt >= 0 ? "+" : ""}
                            {t.pnlUsdt.toFixed(2)}
                          </td>
                        </tr>
                      ))}
                  </Fragment>
                );
              });
            })()}
          </tbody>
        </table>
      </div>
    </>
  );
}
