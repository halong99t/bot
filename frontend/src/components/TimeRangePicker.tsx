import type { Dispatch, SetStateAction } from "react";

export type RangeMode = "recent" | "year" | "custom";

interface Props {
  mode: RangeMode;
  setMode: (m: RangeMode) => void;
  months: number;
  setMonths: (n: number) => void;
  year: number;
  setYear: (n: number) => void;
  monthsSel: number[];
  setMonthsSel: Dispatch<SetStateAction<number[]>>;
  yearsSel: number[];
  setYearsSel: Dispatch<SetStateAction<number[]>>;
  dataRange: { minTs: number; maxTs: number } | null;
  /** Giới hạn xem trước theo data có sẵn (nguồn local). */
  clampToData?: boolean;
  disabled?: boolean;
  /**
   * Chế độ CỬA SỔ NGẮN (dùng cho khung 15m): ẩn "Gần đây" & "Theo năm",
   * chỉ cho chọn 1 THÁNG + khoảng NGÀY (tối đa 1 tháng). Cần dayFrom/dayTo.
   */
  granular?: boolean;
  dayFrom?: number;
  dayTo?: number;
  setDayFrom?: (n: number) => void;
  setDayTo?: (n: number) => void;
}

const MONTH_OPTS = [1, 2, 3, 4, 6, 9, 12];
const fmtD = (ts: number) => new Date(ts).toLocaleDateString();
const daysInMonth = (year: number, month1: number) => new Date(year, month1, 0).getDate();

export default function TimeRangePicker({
  mode,
  setMode,
  months,
  setMonths,
  year,
  setYear,
  monthsSel,
  setMonthsSel,
  yearsSel,
  setYearsSel,
  dataRange,
  clampToData,
  disabled,
  granular,
  dayFrom,
  dayTo,
  setDayFrom,
  setDayTo,
}: Props) {
  // Năm/tháng hợp lệ theo khoảng data
  const availYears = (() => {
    if (!dataRange) return [2021, 2022, 2023, 2024, 2025, 2026];
    const a = new Date(dataRange.minTs).getUTCFullYear();
    const b = new Date(dataRange.maxTs).getUTCFullYear();
    const out: number[] = [];
    for (let y = a; y <= b; y++) out.push(y);
    return out;
  })();
  const availMonths = (() => {
    if (!dataRange) return [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
    const minD = new Date(dataRange.minTs);
    const maxD = new Date(dataRange.maxTs);
    const start = year === minD.getUTCFullYear() ? minD.getUTCMonth() + 1 : 1;
    const end = year === maxD.getUTCFullYear() ? maxD.getUTCMonth() + 1 : 12;
    const out: number[] = [];
    for (let m = start; m <= end; m++) out.push(m);
    return out;
  })();

  // Khoảng test xem trước [from, to]
  const preview = (() => {
    if (mode === "recent") {
      const to = Date.now();
      let from = to - months * 30 * 24 * 60 * 60 * 1000;
      let t = to;
      if (clampToData && dataRange) {
        from = Math.max(from, dataRange.minTs);
        t = Math.min(to, dataRange.maxTs);
      }
      return { from, to: t };
    }
    if (mode === "year") {
      if (!yearsSel.length) return null;
      return {
        from: new Date(Math.min(...yearsSel), 0, 1).getTime(),
        to: new Date(Math.max(...yearsSel), 11, 31).getTime(),
      };
    }
    if (!monthsSel.length) return null;
    return {
      from: new Date(year, Math.min(...monthsSel) - 1, 1).getTime(),
      to: new Date(year, Math.max(...monthsSel), 1, 0, 0, -1).getTime(),
    };
  })();

  const tab = (m: RangeMode, label: string) => (
    <button
      onClick={() => setMode(m)}
      disabled={disabled}
      className={`btn ${mode === m ? "btn-primary" : "btn-ghost"}`}
    >
      {label}
    </button>
  );

  // ===== Chế độ CỬA SỔ NGẮN (15m): 1 tháng + khoảng ngày, tối đa 1 tháng =====
  if (granular) {
    const selM = monthsSel[0]; // 1 tháng duy nhất
    const nDays = selM ? daysInMonth(year, selM) : 31;
    const dF = Math.min(dayFrom ?? 1, nDays);
    const dT = Math.min(Math.max(dayTo ?? nDays, dF), nDays);
    const dayList = Array.from({ length: nDays }, (_, i) => i + 1);
    const gPreview = selM
      ? { from: new Date(year, selM - 1, dF).getTime(), to: new Date(year, selM - 1, dT + 1).getTime() - 1 }
      : null;
    const spanDays = selM ? dT - dF + 1 : 0;
    const pickMonth = (m: number) => {
      setMonthsSel([m]);
      const nd = daysInMonth(year, m);
      setDayFrom?.(1);
      setDayTo?.(nd);
    };
    return (
      <div className="space-y-2">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs text-accent uppercase font-semibold mr-1">📅 Khoảng thời gian (15m — cửa sổ ngắn)</span>
          <span className="text-[11px] text-gray-500">Test tối đa 1 tháng · chọn tháng + ngày (ngày ↔ tuần ↔ tháng)</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-gray-400 uppercase">Năm</span>
          <select
            className="input w-28"
            value={year}
            onChange={(e) => { setYear(Number(e.target.value)); setMonthsSel([]); }}
            disabled={disabled}
          >
            {availYears.map((y) => <option key={y} value={y}>{y}</option>)}
          </select>
        </div>
        <div>
          <span className="text-xs text-gray-400 uppercase">Tháng (chọn 1)</span>
          <div className="flex flex-wrap gap-1 mt-1">
            {availMonths.map((m) => (
              <button
                key={m}
                onClick={() => pickMonth(m)}
                className={`btn px-2.5 ${selM === m ? "btn-primary" : "btn-ghost"}`}
                disabled={disabled}
              >
                T{m}
              </button>
            ))}
          </div>
        </div>
        {selM ? (
          <div className="flex items-end gap-3 flex-wrap">
            <label className="block">
              <span className="text-xs text-gray-400 uppercase">Từ ngày</span>
              <select
                className="input w-24 mt-1"
                value={dF}
                onChange={(e) => { const v = Number(e.target.value); setDayFrom?.(v); if (dT < v) setDayTo?.(v); }}
                disabled={disabled}
              >
                {dayList.map((d) => <option key={d} value={d}>{d}</option>)}
              </select>
            </label>
            <label className="block">
              <span className="text-xs text-gray-400 uppercase">Đến ngày</span>
              <select
                className="input w-24 mt-1"
                value={dT}
                onChange={(e) => setDayTo?.(Number(e.target.value))}
                disabled={disabled}
              >
                {dayList.filter((d) => d >= dF).map((d) => <option key={d} value={d}>{d}</option>)}
              </select>
            </label>
            <div className="flex gap-1">
              <button className="btn btn-ghost px-2 text-xs" disabled={disabled} onClick={() => { setDayFrom?.(dF); setDayTo?.(Math.min(dF + 6, nDays)); }}>1 tuần</button>
              <button className="btn btn-ghost px-2 text-xs" disabled={disabled} onClick={() => { setDayFrom?.(dF); setDayTo?.(dF); }}>1 ngày</button>
              <button className="btn btn-ghost px-2 text-xs" disabled={disabled} onClick={() => { setDayFrom?.(1); setDayTo?.(nDays); }}>Cả tháng</button>
            </div>
          </div>
        ) : null}
        {gPreview ? (
          <p className="text-[11px] text-accent">
            📅 Test: <b>{fmtD(gPreview.from)}</b> → <b>{fmtD(gPreview.to)}</b> ({spanDays} ngày)
          </p>
        ) : (
          <p className="text-[11px] text-gray-500">Chưa chọn tháng</p>
        )}
        {dataRange && (
          <p className="text-[11px] text-gray-500">Dữ liệu có từ {fmtD(dataRange.minTs)} đến {fmtD(dataRange.maxTs)}.</p>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-xs text-accent uppercase font-semibold mr-1">📅 Khoảng thời gian</span>
        {tab("recent", "Gần đây")}
        {tab("year", "Theo năm")}
        {tab("custom", "Tháng cụ thể")}
      </div>

      {mode === "recent" && (
        <label className="block">
          <span className="text-xs text-gray-400 uppercase">Số tháng gần nhất</span>
          <select
            className="input w-40 mt-1"
            value={months}
            onChange={(e) => setMonths(Number(e.target.value))}
            disabled={disabled}
          >
            {MONTH_OPTS.map((o) => (
              <option key={o} value={o}>
                {o} tháng
              </option>
            ))}
          </select>
        </label>
      )}

      {mode === "year" && (
        <div>
          <span className="text-xs text-gray-400 uppercase">Chọn năm (1 hoặc nhiều)</span>
          <div className="flex flex-wrap gap-1 mt-1">
            {availYears.map((y) => (
              <button
                key={y}
                onClick={() => setYearsSel((s) => (s.includes(y) ? s.filter((x) => x !== y) : [...s, y]))}
                className={`btn px-3 ${yearsSel.includes(y) ? "btn-primary" : "btn-ghost"}`}
                disabled={disabled}
              >
                {y}
              </button>
            ))}
          </div>
        </div>
      )}

      {mode === "custom" && (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <span className="text-xs text-gray-400 uppercase">Năm</span>
            <select
              className="input w-28"
              value={year}
              onChange={(e) => {
                setYear(Number(e.target.value));
                setMonthsSel([]);
              }}
              disabled={disabled}
            >
              {availYears.map((y) => (
                <option key={y} value={y}>
                  {y}
                </option>
              ))}
            </select>
          </div>
          <div>
            <span className="text-xs text-gray-400 uppercase">Tháng (1 hoặc nhiều)</span>
            <div className="flex flex-wrap gap-1 mt-1">
              {availMonths.map((m) => (
                <button
                  key={m}
                  onClick={() => setMonthsSel((s) => (s.includes(m) ? s.filter((x) => x !== m) : [...s, m]))}
                  className={`btn px-2.5 ${monthsSel.includes(m) ? "btn-primary" : "btn-ghost"}`}
                  disabled={disabled}
                >
                  T{m}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {preview ? (
        <p className="text-[11px] text-accent">
          📅 Test: <b>{fmtD(preview.from)}</b> → <b>{fmtD(preview.to)}</b>
          {mode === "year" ? " (trọn năm)" : ""}
        </p>
      ) : (
        <p className="text-[11px] text-gray-500">Chưa chọn {mode === "year" ? "năm" : "tháng"}</p>
      )}
      {dataRange && (
        <p className="text-[11px] text-gray-500">
          Dữ liệu có từ {fmtD(dataRange.minTs)} đến {fmtD(dataRange.maxTs)}.
        </p>
      )}
    </div>
  );
}
