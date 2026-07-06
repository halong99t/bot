import axios, { AxiosInstance, AxiosError } from "axios";
import crypto from "crypto";
import { env } from "../config/env";
import { logger } from "./logger";

/**
 * Binance USDⓈ-M Futures REST client.
 * - Public endpoints: không cần ký.
 * - Private (trade/account): ký HMAC SHA256 bằng API secret.
 * - Có retry + xử lý lỗi rate limit (418/429) và lỗi nghiệp vụ Binance.
 */

// Dữ liệu thị trường (klines/ticker/exchangeInfo...) LUÔN lấy từ production = giá thật.
const DATA_BASE = "https://fapi.binance.com";
// Giao dịch (đặt/đóng lệnh, đòn bẩy, số dư) theo cờ testnet.
const TRADE_BASE = env.BINANCE_TESTNET
  ? "https://testnet.binancefuture.com"
  : "https://fapi.binance.com";

export interface ExchangeSymbol {
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  status: string;
  contractType: string;
  pricePrecision: number;
  quantityPrecision: number;
}

export interface Ticker24h {
  symbol: string;
  lastPrice: string;
  priceChangePercent: string;
  volume: string;
  quoteVolume: string;
}

export interface Kline {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  closeTime: number;
}

export class BinanceError extends Error {
  code?: number;
  httpStatus?: number;
  constructor(message: string, code?: number, httpStatus?: number) {
    super(message);
    this.name = "BinanceError";
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

class BinanceClient {
  private dataHttp: AxiosInstance; // market data — production
  private tradeHttp: AxiosInstance; // trading — testnet/production theo cờ
  private apiKey: string;
  private apiSecret: string;

  constructor() {
    this.apiKey = env.BINANCE_API_KEY;
    this.apiSecret = env.BINANCE_API_SECRET;
    this.dataHttp = axios.create({ baseURL: DATA_BASE, timeout: 15000 });
    this.tradeHttp = axios.create({
      baseURL: TRADE_BASE,
      timeout: 15000,
      headers: { "X-MBX-APIKEY": this.apiKey },
    });
  }

  /** Cập nhật key động (khi user đổi trong Settings) — chỉ ảnh hưởng client trading */
  setCredentials(apiKey?: string | null, apiSecret?: string | null) {
    if (apiKey) {
      this.apiKey = apiKey;
      this.tradeHttp.defaults.headers["X-MBX-APIKEY"] = apiKey;
    }
    if (apiSecret) this.apiSecret = apiSecret;
  }

  private sign(query: string): string {
    return crypto.createHmac("sha256", this.apiSecret).update(query).digest("hex");
  }

  /**
   * Gọi API có retry. Xử lý:
   *  - 429/418: bị rate-limit / IP ban tạm thời -> backoff theo Retry-After.
   *  - Lỗi mạng (ECONNRESET, ETIMEDOUT) -> retry.
   *  - Lỗi nghiệp vụ Binance (có .code) -> ném BinanceError, không retry.
   */
  private async request<T>(
    method: "GET" | "POST" | "DELETE",
    path: string,
    params: Record<string, string | number | boolean> = {},
    signed = false,
    attempt = 1
  ): Promise<T> {
    const maxAttempts = 4;
    try {
      let finalParams = { ...params };
      if (signed) {
        if (!this.apiKey || !this.apiSecret) {
          throw new BinanceError("Thiếu Binance API key/secret cho endpoint cần xác thực");
        }
        finalParams.timestamp = Date.now();
        finalParams.recvWindow = 5000;
        const query = new URLSearchParams(
          Object.entries(finalParams).map(([k, v]) => [k, String(v)])
        ).toString();
        const signature = this.sign(query);
        path = `${path}?${query}&signature=${signature}`;
        finalParams = {};
      }

      // signed (trade/account) -> tradeHttp; public market data -> dataHttp (production)
      const client = signed ? this.tradeHttp : this.dataHttp;
      const res = await client.request<T>({
        method,
        url: path,
        params: signed ? undefined : finalParams,
      });
      return res.data;
    } catch (err) {
      const axErr = err as AxiosError<{ code?: number; msg?: string }>;
      const status = axErr.response?.status;
      const binanceCode = axErr.response?.data?.code;
      const binanceMsg = axErr.response?.data?.msg;

      // Rate limit / IP ban -> backoff
      if ((status === 429 || status === 418) && attempt <= maxAttempts) {
        const retryAfter = Number(axErr.response?.headers?.["retry-after"] ?? attempt * 2);
        const waitMs = Math.min(retryAfter * 1000, 30000);
        logger.warn("binance", `Rate limited (${status}). Chờ ${waitMs}ms rồi retry`, {
          path,
          attempt,
        });
        await sleep(waitMs);
        return this.request<T>(method, path, params, signed, attempt + 1);
      }

      // Lỗi mạng tạm thời -> retry với exponential backoff
      const networkCode = (axErr as any).code as string | undefined;
      if (
        !status &&
        networkCode &&
        ["ECONNRESET", "ETIMEDOUT", "ECONNABORTED", "ENOTFOUND"].includes(networkCode) &&
        attempt <= maxAttempts
      ) {
        const waitMs = Math.min(1000 * 2 ** (attempt - 1), 15000);
        logger.warn("binance", `Lỗi mạng ${networkCode}. Retry sau ${waitMs}ms`, { path, attempt });
        await sleep(waitMs);
        return this.request<T>(method, path, params, signed, attempt + 1);
      }

      // Lỗi nghiệp vụ Binance
      const msg = binanceMsg ?? axErr.message ?? "Unknown Binance error";
      logger.error("binance", `API error: ${msg}`, { path, status, code: binanceCode });
      throw new BinanceError(msg, binanceCode, status);
    }
  }

  // ===================== PUBLIC =====================

  /** Lấy toàn bộ symbol đang TRADING, contract PERPETUAL, quote = USDT */
  async getUsdtPerpetualSymbols(): Promise<ExchangeSymbol[]> {
    const data = await this.request<{ symbols: any[] }>("GET", "/fapi/v1/exchangeInfo");
    return data.symbols
      .filter(
        (s) =>
          s.quoteAsset === "USDT" &&
          s.status === "TRADING" &&
          s.contractType === "PERPETUAL"
      )
      .map((s) => ({
        symbol: s.symbol,
        baseAsset: s.baseAsset,
        quoteAsset: s.quoteAsset,
        status: s.status,
        contractType: s.contractType,
        pricePrecision: s.pricePrecision,
        quantityPrecision: s.quantityPrecision,
      }));
  }

  /** 24h ticker cho toàn bộ symbol (1 request) */
  async getAll24hTickers(): Promise<Ticker24h[]> {
    return this.request<Ticker24h[]>("GET", "/fapi/v1/ticker/24hr");
  }

  /** Premium index = chứa lastFundingRate + markPrice cho toàn bộ symbol */
  async getAllPremiumIndex(): Promise<any[]> {
    return this.request<any[]>("GET", "/fapi/v1/premiumIndex");
  }

  /** Open interest cho 1 symbol */
  async getOpenInterest(symbol: string): Promise<number> {
    const data = await this.request<{ openInterest: string }>(
      "GET",
      "/fapi/v1/openInterest",
      { symbol }
    );
    return parseFloat(data.openInterest);
  }

  /** Klines (nến) — dùng cho tính chỉ báo và phát hiện mô hình */
  async getKlines(symbol: string, interval = "15m", limit = 200): Promise<Kline[]> {
    const raw = await this.request<any[][]>("GET", "/fapi/v1/klines", {
      symbol,
      interval,
      limit,
    });
    return raw.map((k) => ({
      openTime: k[0],
      open: parseFloat(k[1]),
      high: parseFloat(k[2]),
      low: parseFloat(k[3]),
      close: parseFloat(k[4]),
      volume: parseFloat(k[5]),
      closeTime: k[6],
    }));
  }

  /**
   * Lấy klines trong một khoảng thời gian [startTime, endTime] (ms),
   * tự phân trang (Binance giới hạn 1500 nến/request) — dùng cho backtest.
   */
  async getKlinesRange(
    symbol: string,
    interval: string,
    startTime: number,
    endTime: number,
    hardCap = 20000
  ): Promise<Kline[]> {
    const out: Kline[] = [];
    let cursor = startTime;
    while (cursor < endTime && out.length < hardCap) {
      const raw = await this.request<any[][]>("GET", "/fapi/v1/klines", {
        symbol,
        interval,
        startTime: cursor,
        endTime,
        limit: 1500,
      });
      if (!raw.length) break;
      for (const k of raw) {
        out.push({
          openTime: k[0],
          open: parseFloat(k[1]),
          high: parseFloat(k[2]),
          low: parseFloat(k[3]),
          close: parseFloat(k[4]),
          volume: parseFloat(k[5]),
          closeTime: k[6],
        });
      }
      const lastOpen = raw[raw.length - 1][0] as number;
      cursor = lastOpen + 1;
      if (raw.length < 1500) break;
    }
    return out;
  }

  /**
   * Funding rate LỊCH SỬ (public) cho 1 symbol trong [startTime, endTime] (ms).
   * Tự phân trang (Binance giới hạn 1000 bản ghi/request). Trả {time, rate} tăng dần.
   */
  async getFundingRateHistory(
    symbol: string,
    startTime: number,
    endTime: number
  ): Promise<{ time: number; rate: number }[]> {
    const out: { time: number; rate: number }[] = [];
    let cursor = startTime;
    while (cursor < endTime) {
      const raw = await this.request<{ fundingTime: number; fundingRate: string }[]>(
        "GET",
        "/fapi/v1/fundingRate",
        { symbol, startTime: cursor, endTime, limit: 1000 }
      );
      if (!raw.length) break;
      for (const r of raw) out.push({ time: r.fundingTime, rate: parseFloat(r.fundingRate) });
      const last = raw[raw.length - 1].fundingTime;
      cursor = last + 1;
      if (raw.length < 1000) break;
    }
    return out;
  }

  // ===================== PRIVATE (TRADE) =====================

  async setLeverage(symbol: string, leverage: number): Promise<void> {
    await this.request("POST", "/fapi/v1/leverage", { symbol, leverage }, true);
  }

  /**
   * Đặt chế độ ký quỹ ISOLATED/CROSSED cho symbol.
   * Binance trả lỗi -4046 nếu không cần đổi (đã đúng chế độ) -> bỏ qua an toàn.
   */
  async setMarginType(symbol: string, marginMode: "CROSS" | "ISOLATED"): Promise<void> {
    const marginType = marginMode === "ISOLATED" ? "ISOLATED" : "CROSSED";
    try {
      await this.request("POST", "/fapi/v1/marginType", { symbol, marginType }, true);
    } catch (err) {
      if (err instanceof BinanceError && err.code === -4046) return; // "No need to change margin type"
      throw err;
    }
  }

  /** Đặt lệnh MARKET */
  async placeMarketOrder(
    symbol: string,
    side: "BUY" | "SELL",
    quantity: number
  ): Promise<{ orderId: number; avgPrice: string; status: string }> {
    return this.request(
      "POST",
      "/fapi/v1/order",
      { symbol, side, type: "MARKET", quantity },
      true
    );
  }

  /** Đóng vị thế LONG = SELL với reduceOnly */
  async closeLong(symbol: string, quantity: number): Promise<any> {
    return this.request(
      "POST",
      "/fapi/v1/order",
      { symbol, side: "SELL", type: "MARKET", quantity, reduceOnly: true },
      true
    );
  }

  async getAccountBalance(): Promise<any[]> {
    return this.request("GET", "/fapi/v2/balance", {}, true);
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export const binance = new BinanceClient();
