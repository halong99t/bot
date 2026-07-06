export interface MarketData {
  id: number;
  symbol: string;
  price: number;
  volume24h: number;
  quoteVolume: number;
  priceChange24h: number;
  fundingRate: number | null;
  openInterest: number | null;
  marketCap: number | null;
  atr: number | null;
  rsi: number | null;
  ema20: number | null;
  ema50: number | null;
  ema200: number | null;
  createdAt: string;
}

export interface Rankings {
  topGainers: MarketData[];
  topVolume: MarketData[];
  topFunding: MarketData[];
  topOpenInterest: MarketData[];
  all: MarketData[];
}

export interface Signal {
  id: number;
  symbol: string;
  type: "LONG" | "SHORT";
  status: "PENDING" | "EXECUTED" | "EXPIRED" | "CANCELLED";
  entryPrice: number;
  takeProfit: number;
  stopLoss: number;
  probability: number;
  reason: string | null;
  detectedAt: string;
}

export interface Position {
  id: number;
  symbol: string;
  side: string;
  status: "OPEN" | "CLOSED";
  entryPrice: number;
  quantity: number;
  takeProfit: number;
  stopLoss: number;
  leverage: number;
  currentPrice: number | null;
  pnl: number;
  pnlPct: number;
  openedAt: string;
}

export interface Trade {
  id: number;
  symbol: string;
  side: string;
  entryPrice: number;
  exitPrice: number;
  quantity: number;
  pnl: number;
  pnlPct: number;
  closeReason: string;
  openedAt: string;
  closedAt: string;
}

export interface Overview {
  coinsScanning: number;
  longSignals: number;
  openPositions: number;
  todayPnl: number;
  todayTradeCount: number;
  winRate: number;
  lastScanAt: string | null;
}

export interface Settings {
  takeProfitPct: number;
  stopLossPct: number;
  orderSizeUsdt: number;
  leverage: number;
  marginMode: "CROSS" | "ISOLATED";
  tpSlMode: "PRICE" | "MARGIN";
  scanIntervalMs: number;
  autoTrade: boolean;
  strategyMode: "LONG" | "TREND";
  regimeMode: "BTC1H_ALT1H";
  paperTrade: boolean;
  riskPerTradePct: number;
  binanceApiKey: string;
  binanceApiSecret: string;
  hasCredentials: boolean;
}

export interface BacktestTrade {
  symbol: string;
  entryTime: number;
  entryPrice: number;
  exitTime: number;
  exitPrice: number;
  pnlPct: number;
  pnlUsdt: number;
  reason: "TP" | "SL" | "LIQ" | "EOD" | "TRAIL" | "FLIP" | "DONCHIAN" | "TIME";
  barsHeld: number;
  probability: number;
  riskPctPrice?: number;
  state?: string;
  alignment?: string;
}

export interface GroupStat {
  key: string;
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  returnPct: number;
  pnlUsdt: number;
  avgReturnPct: number;
}

export interface BlowupTrade {
  seq: number;
  symbol: string;
  state?: string;
  entryTime: number;
  exitTime: number;
  entryPrice: number;
  exitPrice: number;
  reason: string;
  pnlPct: number;
  pnlUsdt: number;
  balanceBefore: number;
  balanceAfter: number;
}

export interface SymbolResult {
  symbol: string;
  candles: number;
  trades: number;
  wins: number;
  returnPct: number;
}

export interface MonthlyStat {
  month: string; // "YYYY-MM"
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  returnPct: number;
  pnlUsdt: number;
  avgReturnPct: number;
}

export interface DailyStat {
  day: string; // "YYYY-MM-DD"
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  returnPct: number;
  pnlUsdt: number;
  avgReturnPct: number;
}

export interface BacktestResult {
  params: {
    months: number;
    interval: string;
    takeProfitPct: number;
    stopLossPct: number;
    minDropPct: number;
    minSidewayCandles: number;
    maxSidewayRangePct: number;
    minRisePct: number;
  };
  from: string;
  to: string;
  symbolsTested: string[];
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  totalReturnPct: number;
  avgReturnPct: number;
  maxWinPct: number;
  maxLossPct: number;
  maxDrawdownPct: number;
  profitFactor: number;
  sharpe: number;
  sortino: number;
  calmar: number;
  cagr: number;
  expectancyR: number;
  maxConsecutiveWins: number;
  maxConsecutiveLosses: number;
  avgHoldingHours: number;
  avgBarsHeld: number;
  equityCurve: number[];
  equityDailyUsdt: number[];
  initialCapitalUsdt: number;
  orderSizeUsdt: number;
  leverage: number;
  totalPnlUsdt: number;
  finalBalanceUsdt: number;
  roiPct: number;
  maxDrawdownUsdt: number;
  equityCurveUsdt: number[];
  maxConcurrentPositions: number;
  candidateTrades: number;
  skippedByCap: number;
  skippedByRisk?: number;
  peakConcurrent: number;
  marginMode: "CROSS" | "ISOLATED";
  tpSlMode: "PRICE" | "MARGIN";
  liquidations: number;
  liqPriceMovePct: number;
  accountBlown: boolean;
  blownAtTrade: number;
  blowupTrades?: BlowupTrade[];
  byMonth?: MonthlyStat[];
  byDay?: DailyStat[];
  byReason?: GroupStat[];
  byState?: GroupStat[];
  byAlignment?: GroupStat[];
  trades: BacktestTrade[];
  perSymbol: SymbolResult[];
}

export interface BacktestHistorySummary {
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  roiPct: number;
  totalReturnPct: number;
  finalBalanceUsdt: number;
  initialCapitalUsdt: number;
  maxDrawdownPct: number;
  maxDrawdownUsdt: number;
  accountBlown: boolean;
  symbolsTested: number;
}

export type BacktestStrategy = "LONG" | "EMA" | "TREND" | "MEANREV";

export interface MeanRevGridRow {
  n: number;
  zEntry: number;
  zStop: number;
  timeStopBars: number;
  adxMax: number;
  trades: number;
  winRate: number;
  roiPct: number;
  maxDrawdownPct: number;
  sharpe: number | null;
  cagr: number;
  calmar: number | null;
  profitFactor: number;
  expectancyR: number;
  accountBlown: boolean;
  score: number;
}
export interface MeanRevGridResult {
  combos: number;
  altInterval: string;
  minTrades: number;
  best: MeanRevGridRow | null;
  ranked: MeanRevGridRow[];
}

export interface BacktestHistoryItem {
  id: number;
  strategy: BacktestStrategy;
  paramsHash: string;
  interval: string;
  year: number;
  month: number; // 1-12
  period: string; // "YYYY-MM"
  label: string | null;
  params: Record<string, number | string | null>;
  summary: BacktestHistorySummary;
  fromDate: string;
  toDate: string;
  createdAt: string;
  updatedAt: string;
  result?: BacktestResult; // chỉ có khi GET theo id
}

export interface BacktestJob {
  id: string;
  status: "running" | "done" | "error";
  progress: number;
  total: number;
  currentSymbol?: string;
  result?: BacktestResult;
  gridResult?: GridResult | MeanRevGridResult;
  error?: string;
  note?: string;
}

export interface GridRow {
  dcEntry: number;
  dcExit: number;
  k1Atr: number;
  k2Atr: number;
  adxMin: number;
  regimeEma: number;
  trades: number;
  winRate: number;
  roiPct: number;
  maxDrawdownPct: number;
  sharpe: number | null;
  cagr: number;
  calmar: number | null;
  profitFactor: number;
  expectancyR: number;
  accountBlown: boolean;
  score: number;
}

export interface GridResult {
  combos: number;
  regimeMode: "BTC1H_ALT1H";
  altInterval: string;
  minTrades: number;
  best: GridRow | null;
  ranked: GridRow[];
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

// ===== EMA / Entry Position Classifier =====
export interface EmaCandleClass {
  timestamp: string;
  openTime?: number;
  close: number;
  fast: number | null;
  slow: number | null;
  state: string;
  bias: string;
  structure: string;
  alignment: string;
  risk: string;
  is_signal: boolean;
}

export interface EmaClassifyResponse {
  symbol: string;
  interval: string;
  fastPeriod: number;
  slowPeriod: number;
  current: EmaCandleClass | null;
  recent: EmaCandleClass[];
}
