import crypto from "crypto";
import { prisma } from "../config/prisma";

export type BacktestParamsInput = Record<string, unknown>;

/**
 * Các field KHÔNG tính vào "bộ thông số": chúng là chiều tách riêng (khung/năm)
 * hoặc chỉ là phạm vi thời gian / dữ liệu thô. Mọi field còn lại đều góp vào hash,
 * nên đổi bất kỳ tham số chiến lược nào (kể cả EMA) => bộ thông số khác => lịch sử riêng.
 */
const EXCLUDE_FROM_HASH = new Set([
  "interval",
  "year",
  "months",
  "fromMs",
  "toMs",
  "from",
  "to",
  "fromDate",
  "toDate",
  "data", // nến import thô
]);

/** Chuẩn hóa 1 giá trị: sort key object, sort mảng primitive -> JSON ổn định bất kể thứ tự. */
function canonicalize(value: unknown): unknown {
  if (value === undefined) return null;
  if (Array.isArray(value)) {
    const items = value.map(canonicalize);
    const allPrimitive = items.every((x) => x === null || typeof x !== "object");
    if (allPrimitive) {
      return [...items].sort((a, b) => String(a).localeCompare(String(b)));
    }
    return items;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      out[k] = canonicalize((value as Record<string, unknown>)[k]);
    }
    return out;
  }
  return value;
}

/** Bỏ các field thời gian/khung/dữ liệu thô khỏi params (giữ lại toàn bộ tham số chiến lược). */
function stripNonParamFields(params: BacktestParamsInput): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params)) {
    if (EXCLUDE_FROM_HASH.has(k)) continue;
    if (v === undefined) continue;
    out[k] = v;
  }
  return out;
}

/** Chuẩn hóa + băm bộ thông số thành 1 fingerprint ổn định (sha1, 16 ký tự). */
export function computeParamsHash(params: BacktestParamsInput): string {
  const canonical = canonicalize(stripNonParamFields(params));
  const str = JSON.stringify(canonical);
  return crypto.createHash("sha1").update(str).digest("hex").slice(0, 16);
}

/** Rút gọn kết quả thành tóm tắt nhẹ để list nhanh (không kéo cả mảng trades). */
function buildSummary(result: any) {
  return {
    totalTrades: result?.totalTrades ?? 0,
    wins: result?.wins ?? 0,
    losses: result?.losses ?? 0,
    winRate: result?.winRate ?? 0,
    roiPct: result?.roiPct ?? 0,
    totalReturnPct: result?.totalReturnPct ?? 0,
    finalBalanceUsdt: result?.finalBalanceUsdt ?? 0,
    initialCapitalUsdt: result?.initialCapitalUsdt ?? 0,
    maxDrawdownPct: result?.maxDrawdownPct ?? 0,
    maxDrawdownUsdt: result?.maxDrawdownUsdt ?? 0,
    accountBlown: result?.accountBlown ?? false,
    symbolsTested: Array.isArray(result?.symbolsTested) ? result.symbolsTested.length : 0,
  };
}

/** Suy ra năm từ mốc bắt đầu (ISO string hoặc epoch ms). */
export function yearFromDate(from: string | number): number {
  const d = typeof from === "number" ? new Date(from) : new Date(from);
  return d.getUTCFullYear();
}

export interface SaveArgs {
  params: BacktestParamsInput;
  interval?: string;
  result: any; // BacktestResult
  label?: string;
  strategy?: string; // "LONG" | "EMA" — nếu bỏ trống sẽ tự suy từ params
}

/** Suy loại chiến lược từ params khi client không truyền. */
export function inferStrategy(params: BacktestParamsInput): string {
  if (params.exitStrategy || params.fastPeriod || params.entryStates) return "EMA";
  return "LONG";
}

/** Khóa tháng "YYYY-MM" (UTC) từ epoch ms. */
function monthKeyOf(ts: number): string {
  const d = new Date(ts);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** Gộp lệnh theo 1 khóa (kiểu thoát/state/alignment) — dùng cho sub-result theo tháng. */
function aggregateBy(trades: any[], keyOf: (t: any) => string | undefined) {
  const map = new Map<string, any>();
  for (const t of trades) {
    const key = keyOf(t);
    if (!key) continue;
    let g = map.get(key);
    if (!g) {
      g = { key, trades: 0, wins: 0, losses: 0, winRate: 0, returnPct: 0, pnlUsdt: 0, avgReturnPct: 0 };
      map.set(key, g);
    }
    g.trades += 1;
    if (t.pnlPct > 0) g.wins += 1;
    else g.losses += 1;
    g.returnPct += t.pnlPct;
    g.pnlUsdt += t.pnlUsdt;
  }
  return [...map.values()]
    .sort((a, b) => b.trades - a.trades)
    .map((g) => ({
      ...g,
      winRate: g.trades ? Number(((g.wins / g.trades) * 100).toFixed(1)) : 0,
      avgReturnPct: g.trades ? Number((g.returnPct / g.trades).toFixed(2)) : 0,
      returnPct: Number(g.returnPct.toFixed(2)),
      pnlUsdt: Number(g.pnlUsdt.toFixed(2)),
    }));
}

/**
 * Dựng 1 BacktestResult CHỈ cho tháng `mk` ("YYYY-MM") từ kết quả tổng:
 * lọc lệnh theo thời gian VÀO, tính lại equity/drawdown/nhóm để trang chi tiết hiển thị đầy đủ.
 */
function buildMonthlyResult(full: any, mk: string): any {
  const initial = Number(full?.initialCapitalUsdt ?? 0);
  const trades = (full?.trades ?? []).filter((t: any) => monthKeyOf(t.entryTime) === mk);
  const byExit = [...trades].sort((a, b) => a.exitTime - b.exitTime);

  let cumPct = 0;
  let balance = initial;
  let peakBal = initial;
  let maxDDUsdt = 0;
  let peakPct = 0;
  let maxDDPct = 0;
  const equityCurve: number[] = [];
  const equityCurveUsdt: number[] = [];
  for (const t of byExit) {
    cumPct += t.pnlPct;
    balance += t.pnlUsdt;
    equityCurve.push(Number(cumPct.toFixed(2)));
    equityCurveUsdt.push(Number(balance.toFixed(2)));
    peakBal = Math.max(peakBal, balance);
    maxDDUsdt = Math.max(maxDDUsdt, peakBal - balance);
    peakPct = Math.max(peakPct, cumPct);
    maxDDPct = Math.max(maxDDPct, peakPct - cumPct);
  }

  const n = trades.length;
  const wins = trades.filter((t: any) => t.pnlPct > 0).length;
  const losses = n - wins;
  const totalReturnPct = trades.reduce((s: number, t: any) => s + t.pnlPct, 0);
  const totalPnlUsdt = trades.reduce((s: number, t: any) => s + t.pnlUsdt, 0);
  const pcts = trades.map((t: any) => t.pnlPct);

  // perSymbol của tháng
  const symMap = new Map<string, any>();
  for (const t of trades) {
    let s = symMap.get(t.symbol);
    if (!s) {
      s = { symbol: t.symbol, candles: 0, trades: 0, wins: 0, returnPct: 0 };
      symMap.set(t.symbol, s);
    }
    s.trades += 1;
    if (t.pnlPct > 0) s.wins += 1;
    s.returnPct += t.pnlPct;
  }
  const perSymbol = [...symMap.values()].map((s) => ({ ...s, returnPct: Number(s.returnPct.toFixed(2)) }));

  // byMonth: dùng lại số liệu tháng từ kết quả tổng nếu có, không thì tự tính
  const monthStat =
    (full?.byMonth ?? []).find((m: any) => m.month === mk) ?? {
      month: mk,
      trades: n,
      wins,
      losses,
      winRate: n ? Number(((wins / n) * 100).toFixed(1)) : 0,
      returnPct: Number(totalReturnPct.toFixed(2)),
      pnlUsdt: Number(totalPnlUsdt.toFixed(2)),
      avgReturnPct: n ? Number((totalReturnPct / n).toFixed(2)) : 0,
    };

  const [y, m] = mk.split("-").map(Number);
  const fromIso = new Date(Date.UTC(y, m - 1, 1)).toISOString();
  const toIso = new Date(Date.UTC(y, m, 1)).toISOString();

  return {
    params: full?.params ?? {},
    from: fromIso,
    to: toIso,
    symbolsTested: [...symMap.keys()],
    totalTrades: n,
    wins,
    losses,
    winRate: n ? Number(((wins / n) * 100).toFixed(1)) : 0,
    totalReturnPct: Number(totalReturnPct.toFixed(2)),
    avgReturnPct: n ? Number((totalReturnPct / n).toFixed(2)) : 0,
    maxWinPct: pcts.length ? Number(Math.max(...pcts).toFixed(2)) : 0,
    maxLossPct: pcts.length ? Number(Math.min(...pcts).toFixed(2)) : 0,
    maxDrawdownPct: Number(maxDDPct.toFixed(2)),
    avgBarsHeld: n ? Number((trades.reduce((s: number, t: any) => s + (t.barsHeld ?? 0), 0) / n).toFixed(1)) : 0,
    equityCurve,
    initialCapitalUsdt: initial,
    orderSizeUsdt: Number(full?.orderSizeUsdt ?? 0),
    leverage: Number(full?.leverage ?? 1),
    totalPnlUsdt: Number(totalPnlUsdt.toFixed(2)),
    finalBalanceUsdt: Number((initial + totalPnlUsdt).toFixed(2)),
    roiPct: initial ? Number(((totalPnlUsdt / initial) * 100).toFixed(2)) : 0,
    maxDrawdownUsdt: Number(maxDDUsdt.toFixed(2)),
    equityCurveUsdt,
    maxConcurrentPositions: Number(full?.maxConcurrentPositions ?? 0),
    candidateTrades: n,
    skippedByCap: 0,
    peakConcurrent: 0,
    marginMode: full?.marginMode ?? "CROSS",
    tpSlMode: full?.tpSlMode ?? "MARGIN",
    liquidations: trades.filter((t: any) => t.reason === "LIQ").length,
    liqPriceMovePct: Number(full?.liqPriceMovePct ?? 0),
    accountBlown: false,
    blownAtTrade: 0,
    blowupTrades: [],
    byMonth: [monthStat],
    byReason: aggregateBy(trades, (t) => t.reason),
    byState: aggregateBy(trades, (t) => t.state),
    byAlignment: aggregateBy(trades, (t) => t.alignment),
    trades,
    perSymbol,
  };
}

/** Danh sách khóa tháng có trong 1 lần chạy (ưu tiên byMonth, fallback: theo entryTime, cuối cùng: tháng của `from`). */
function monthKeysOf(result: any): string[] {
  const fromByMonth = (result?.byMonth ?? []).map((m: any) => m.month).filter(Boolean);
  if (fromByMonth.length) return fromByMonth;
  const set = new Set<string>();
  for (const t of result?.trades ?? []) set.add(monthKeyOf(t.entryTime));
  if (set.size) return [...set];
  return [monthKeyOf(new Date(result?.from ?? Date.now()).getTime())];
}

/**
 * Lưu lịch sử: TÁCH lần chạy thành nhiều bản ghi theo THÁNG.
 * Mỗi tháng upsert theo khóa (paramsHash, interval, year, month) => chạy lại cùng tháng sẽ ghi đè.
 * Trả về mảng các bản ghi đã lưu.
 */
export async function saveBacktestHistory(args: SaveArgs) {
  const { params, result, label } = args;
  const interval = args.interval ?? result?.params?.interval ?? "1h";
  const strategy = args.strategy ?? inferStrategy(params);
  const paramsHash = computeParamsHash(params);
  const paramsJson = JSON.stringify(stripNonParamFields(params));

  const saved: any[] = [];
  for (const mk of monthKeysOf(result)) {
    const [year, month] = mk.split("-").map(Number);
    const sub = buildMonthlyResult(result, mk);
    const summaryJson = JSON.stringify(buildSummary(sub));
    const resultJson = JSON.stringify(sub);
    const record = await prisma.backtestHistory.upsert({
      where: { paramsHash_interval_year_month: { paramsHash, interval, year, month } },
      create: {
        strategy,
        paramsHash,
        interval,
        year,
        month,
        period: mk,
        label: label ?? null,
        params: paramsJson,
        summary: summaryJson,
        result: resultJson,
        fromDate: sub.from,
        toDate: sub.to,
      },
      update: {
        strategy,
        period: mk,
        label: label ?? null,
        params: paramsJson,
        summary: summaryJson,
        result: resultJson,
        fromDate: sub.from,
        toDate: sub.to,
      },
    });
    saved.push(toListItem(record));
  }
  return saved;
}

/** Danh sách lịch sử (không kèm result đầy đủ). Lọc theo strategy/năm/tháng/khung nếu truyền. */
export async function listBacktestHistory(
  opts: { year?: number; month?: number; interval?: string; strategy?: string } = {}
) {
  const where: Record<string, unknown> = {};
  if (opts.year) where.year = opts.year;
  if (opts.month) where.month = opts.month;
  if (opts.interval) where.interval = opts.interval;
  if (opts.strategy) where.strategy = opts.strategy;
  const rows = await prisma.backtestHistory.findMany({
    where,
    orderBy: [{ year: "desc" }, { month: "desc" }, { updatedAt: "desc" }],
  });
  return rows.map(toListItem);
}

/** 1 bản ghi đầy đủ (kèm result parse sẵn). */
export async function getBacktestHistory(id: number) {
  const row = await prisma.backtestHistory.findUnique({ where: { id } });
  if (!row) return null;
  return {
    ...toListItem(row),
    result: safeParse(row.result),
  };
}

export async function deleteBacktestHistory(id: number) {
  // deleteMany: không ném lỗi nếu id không tồn tại (idempotent)
  await prisma.backtestHistory.deleteMany({ where: { id } });
}

/** Xóa hàng loạt theo bộ lọc (bỏ trống hết = xóa TẤT CẢ). Trả về số bản ghi đã xóa. */
export async function clearBacktestHistory(
  opts: { strategy?: string; year?: number; month?: number } = {}
) {
  const where: Record<string, unknown> = {};
  if (opts.strategy) where.strategy = opts.strategy;
  if (opts.year) where.year = opts.year;
  if (opts.month) where.month = opts.month;
  const res = await prisma.backtestHistory.deleteMany({ where });
  return res.count;
}

function toListItem(row: any) {
  return {
    id: row.id,
    strategy: row.strategy,
    paramsHash: row.paramsHash,
    interval: row.interval,
    year: row.year,
    month: row.month,
    period: row.period,
    label: row.label ?? null,
    params: safeParse(row.params),
    summary: safeParse(row.summary),
    fromDate: row.fromDate,
    toDate: row.toDate,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function safeParse(s: string) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
