import axios from "axios";
import type {
  MarketData,
  Rankings,
  Signal,
  Position,
  Trade,
  Overview,
  Settings,
  Kline,
  BacktestResult,
  BacktestJob,
  BacktestHistoryItem,
  EmaClassifyResponse,
} from "../types";

const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:4000";

export const http = axios.create({
  baseURL: `${API_URL}/api`,
  // 0 = không giới hạn thời gian chờ (backtest nặng có thể chạy rất lâu).
  timeout: 0,
});

// Xử lý lỗi tập trung
http.interceptors.response.use(
  (res) => res,
  (err) => {
    const msg = err.response?.data?.message ?? err.message ?? "Lỗi không xác định";
    console.error("[API]", msg);
    return Promise.reject(err);
  }
);

export const api = {
  getOverview: () => http.get<Overview>("/overview").then((r) => r.data),
  getLogs: () => http.get("/overview/logs").then((r) => r.data),

  getCoins: () => http.get<MarketData[]>("/coins").then((r) => r.data),
  getRankings: () => http.get<Rankings>("/coins/rankings").then((r) => r.data),
  getKlines: (symbol: string, interval = "15m", limit = 300) =>
    http
      .get<{ symbol: string; interval: string; klines: Kline[]; indicators: any }>(
        `/coins/${symbol}/klines`,
        { params: { interval, limit } }
      )
      .then((r) => r.data),

  getSignals: (status?: string) =>
    http.get<Signal[]>("/signals", { params: { status } }).then((r) => r.data),
  executeSignal: (id: number) => http.post(`/signals/${id}/execute`).then((r) => r.data),
  cancelSignal: (id: number) => http.post(`/signals/${id}/cancel`).then((r) => r.data),

  getPositions: (status = "OPEN") =>
    http.get<Position[]>("/positions", { params: { status } }).then((r) => r.data),
  closePosition: (id: number) => http.post(`/positions/${id}/close`).then((r) => r.data),

  getTrades: () => http.get<Trade[]>("/trades").then((r) => r.data),

  getSettings: () => http.get<Settings>("/settings").then((r) => r.data),
  updateSettings: (data: Partial<Settings>) =>
    http.put("/settings", data).then((r) => r.data),
  getRegime: () =>
    http
      .get<{ side: "LONG" | "SHORT" | "OFF"; close: number | null; ema: number | null; at: number | null }>(
        "/settings/regime"
      )
      .then((r) => r.data),

  runBacktest: (body: Record<string, unknown>) =>
    http
      .post<BacktestResult>("/backtest", body)
      .then((r) => r.data),

  runFullBacktest: (body: Record<string, unknown>) =>
    http.post<{ jobId: string; total: number }>("/backtest/all", body).then((r) => r.data),
  runImportedBacktest: (body: Record<string, unknown>) =>
    http.post<BacktestResult>("/backtest/imported", body).then((r) => r.data),
  getLocalSymbols: () =>
    http.get<{ count: number; symbols: string[] }>("/backtest/local/symbols").then((r) => r.data),
  getLocalKlines: (
    symbol: string,
    interval = "1m",
    limit = 5000,
    from?: number,
    to?: number
  ) =>
    http
      .get<{ symbol: string; interval: string; klines: Kline[]; indicators: any }>(
        `/backtest/local/${symbol}/klines`,
        { params: { interval, limit, from, to } }
      )
      .then((r) => r.data),
  getLocalSymbolRange: (symbol: string) =>
    http
      .get<{ minTs: number; maxTs: number }>(`/backtest/local/${symbol}/range`)
      .then((r) => r.data),
  getLocalFlagged: () =>
    http
      .get<{
        count: number;
        flagged: {
          symbol: string;
          days: number;
          zeroVolPct: number;
          maxZeroRun: number;
        }[];
      }>("/backtest/local/flagged")
      .then((r) => r.data),
  getLocalRange: () =>
    http.get<{ minTs: number; maxTs: number }>("/backtest/local/range").then((r) => r.data),
  getCacheStatus: (interval: string) =>
    http
      .get<{ cached: number; total: number; building: boolean }>("/backtest/local/cache-status", {
        params: { interval },
      })
      .then((r) => r.data),
  runLocalBacktest: (body: Record<string, unknown>) =>
    http.post<{ jobId: string; total: number }>("/backtest/local", body).then((r) => r.data),
  getBacktestJob: (id: string) =>
    http.get<BacktestJob>(`/backtest/jobs/${id}`).then((r) => r.data),

  // ===== Trend following =====
  runTrendBacktest: (body: Record<string, unknown>) =>
    http.post<{ jobId: string; total: number }>("/backtest/trend/local", body).then((r) => r.data),
  runRouterBacktest: (body: Record<string, unknown>) =>
    http.post<{ jobId: string; total: number }>("/backtest/router/local", body).then((r) => r.data),
  runTrendGrid: (body: Record<string, unknown>) =>
    http.post<{ jobId: string; total: number }>("/backtest/trend/grid", body).then((r) => r.data),
  runMeanRevBacktest: (body: Record<string, unknown>) =>
    http.post<{ jobId: string; total: number }>("/backtest/meanrev/local", body).then((r) => r.data),
  runMeanRevGrid: (body: Record<string, unknown>) =>
    http.post<{ jobId: string; total: number }>("/backtest/meanrev/grid", body).then((r) => r.data),
  fetchBtcRegime: (body: Record<string, unknown>) =>
    http
      .post<{
        symbol: string;
        interval: string;
        emaPeriod: number;
        candles: number;
        from: string | null;
        to: string | null;
        currentRegime: "LONG" | "SHORT" | "OFF";
        longBars: number;
        shortBars: number;
        offBars?: number;
        byMonth?: { month: string; long: number; short: number; off: number; longPct: number; shortPct: number; offPct: number }[];
      }>("/backtest/btc/fetch", body)
      .then((r) => r.data),

  // ===== Tải dữ liệu 1m từ Binance =====
  getMajorsStatus: () =>
    http
      .get<{ majors: { symbol: string; present: boolean }[]; missing: string[] }>("/backtest/data/majors")
      .then((r) => r.data),
  downloadData: (body: { symbols: string[]; fromMs?: number; toMs?: number }) =>
    http.post<{ jobId: string; total: number }>("/backtest/data/download", body).then((r) => r.data),

  // ===== Lịch sử backtest =====
  saveBacktestHistory: (body: {
    params: Record<string, unknown>;
    interval?: string;
    label?: string;
    strategy?: "LONG" | "EMA" | "TREND" | "MEANREV";
    result: BacktestResult;
  }) =>
    http
      .post<{ count: number; items: BacktestHistoryItem[] }>("/backtest/history", body)
      .then((r) => r.data),
  listBacktestHistory: (params?: {
    year?: number;
    month?: number;
    interval?: string;
    strategy?: "LONG" | "EMA" | "TREND" | "MEANREV";
  }) => http.get<BacktestHistoryItem[]>("/backtest/history", { params }).then((r) => r.data),
  getBacktestHistory: (id: number) =>
    http.get<BacktestHistoryItem>(`/backtest/history/${id}`).then((r) => r.data),
  deleteBacktestHistory: (id: number) =>
    http.delete<{ ok: boolean }>(`/backtest/history/${id}`).then((r) => r.data),
  clearBacktestHistory: (params?: { strategy?: "LONG" | "EMA" | "TREND" | "MEANREV"; year?: number; month?: number }) =>
    http.delete<{ count: number }>("/backtest/history", { params }).then((r) => r.data),

  // ===== EMA classifier =====
  classifyEma: (params: Record<string, unknown>) =>
    http.get<EmaClassifyResponse>("/ema/classify", { params }).then((r) => r.data),
  runEmaBacktest: (body: Record<string, unknown>) =>
    http.post<{ jobId: string; total: number }>("/ema/backtest/local", body).then((r) => r.data),
};
