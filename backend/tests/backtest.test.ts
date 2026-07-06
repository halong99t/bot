/**
 * Unit tests cho backtest engine (sau audit/refactor).
 * Chạy: npm run test  (node --import tsx --test tests/backtest.test.ts)
 *
 * Bao phủ danh sách trong prompt-fix-backtest.md:
 *  1. Gap qua SL -> fill tại open (LONG & SHORT)
 *  2. Liq có mmr; LIQ chặn trước SL -> riskPctPrice = khoảng cách tới liq
 *  3. DD bắt được đáy MAE rơi giữa 2 mốc ngày
 *  4. MFE tạo peak -> DD mới > DD cũ
 *  5. Sortino đối chiếu tính tay
 *  6. Cháy CROSS -> force-close, equity=0 vĩnh viễn, không mở lệnh sau blownAt
 *  7. margin > cash -> co usdtPerPct đúng tỷ lệ cash/margin
 *  8. Tie-break: cùng timestamp -> kết quả tái lập qua nhiều lần chạy
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  simulateSymbol,
  simulateSymbolEma,
  simulatePortfolio,
  BacktestTrade,
} from "../src/services/backtest.service";
import { classifySeries } from "../src/services/emaClassifier.service";
import type { Kline } from "../src/lib/binance";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const T0 = 1_700_000_000_000;

function k(i: number, o: number, h: number, l: number, c: number): Kline {
  return { openTime: T0 + i * HOUR, open: o, high: h, low: l, close: c, volume: 1, closeTime: T0 + i * HOUR + HOUR - 1 };
}

/** Chuỗi nến khớp detectLongPattern: 60 nến ~100 -> 25 nến sideway 84-85 -> 3 nến breakout tới 95. */
function longPatternSeries(exit: Kline[]): Kline[] {
  const out: Kline[] = [];
  let i = 0;
  for (; i < 60; i++) out.push(k(i, 100, 100, 99, 100)); // pre: đỉnh 100 (mốc drop)
  for (; i < 85; i++) out.push(k(i, 84.5, 85, 84, 84.5)); // sideway low84 high85 (range 1.19%)
  out.push(k(85, 85, 88, 85, 88)); // breakout 1 (bullish)
  out.push(k(86, 88, 92, 88, 92)); // breakout 2
  out.push(k(87, 92, 95, 92, 95)); // breakout 3 -> entry = 95
  return [...out, ...exit];
}

function mkTrade(t: Partial<BacktestTrade>): BacktestTrade {
  return {
    symbol: "T", entryTime: T0, entryPrice: 100, exitTime: T0 + HOUR, exitPrice: 100,
    pnlPct: 0, pnlUsdt: 0, reason: "TP", barsHeld: 1, probability: 50, ...t,
  };
}

const approx = (a: number, b: number, tol = 0.05) => Math.abs(a - b) <= tol;

// ---------------------------------------------------------------------------
test("#1 LONG: gap qua SL -> fill tại open (tệ hơn mức SL)", () => {
  // entry 95, slPct 10 -> sl 85.5. Nến thoát mở gap xuống 80 (< sl) -> fill tại 80.
  const gap = k(88, 80, 81, 70, 75);
  const trades = simulateSymbol("T", longPatternSeries([gap]), 100, 10, {}, 1, "CROSS", "PRICE", 0.5);
  assert.equal(trades.length, 1);
  const tr = trades[0];
  assert.equal(tr.entryPrice, 95);
  assert.equal(tr.reason, "SL");
  assert.equal(tr.exitPrice, 80, "phải fill tại open 80, không phải 85.5");
});

test("#1 SHORT: gap qua SL -> fill tại open (EMA)", () => {
  // Dựng uptrend -> downtrend để phát tín hiệu SHORT, rồi ép nến kế tiếp gap NGƯỢC (lên) qua SL.
  const closes: number[] = [];
  for (let i = 0; i < 12; i++) closes.push(100 + i);        // uptrend
  for (let i = 1; i <= 22; i++) closes.push(111 - 3 * i);   // downtrend mạnh
  const kl: Kline[] = closes.map((c, i) =>
    k(i, i ? closes[i - 1] : c, Math.max(c, i ? closes[i - 1] : c) + 0.5, Math.min(c, i ? closes[i - 1] : c) - 0.5, c)
  );
  const cfg = {
    fastPeriod: 3, slowPeriod: 6, atrPeriod: 3, epsilonMode: "absolute" as const, epsilonValue: 0,
    tpPct: 100, slPct: 10, leverage: 1, marginMode: "CROSS" as const, tpSlMode: "PRICE" as const,
    entryStates: new Set(["SHORT1", "SHORT2", "SHORT3"]), mmr: 0.5,
  };
  // Tìm bar SHORT-signal đầu tiên (trùng logic sim -> đúng bar sim sẽ vào lệnh).
  const cls = classifySeries(kl, { fastPeriod: 3, slowPeriod: 6, atrPeriod: 3, epsilonMode: "absolute", epsilonValue: 0 });
  const iSig = cls.findIndex((c) => c.isSignal && c.cls.bias === "SHORT" && cfg.entryStates.has(c.cls.state));
  assert.ok(iSig > 0 && iSig + 1 < kl.length, `phải có tín hiệu SHORT (idx=${iSig})`);
  const entry = kl[iSig].close;
  const stop = entry * (1 + cfg.slPct / 100); // SHORT: SL ở TRÊN entry
  // Ép nến kế tiếp gap LÊN vượt SL -> fill tại open (tệ hơn stop).
  kl[iSig + 1] = k(iSig + 1, stop * 1.05, stop * 1.06, entry * 0.5, entry * 0.9);
  const trades = simulateSymbolEma("T", kl, cfg);
  const tr = trades.find((t) => t.entryTime === kl[iSig].openTime);
  assert.ok(tr, "phải có lệnh SHORT tại bar tín hiệu");
  assert.equal(tr!.side, "SHORT");
  assert.equal(tr!.reason, "SL");
  assert.equal(tr!.exitPrice, stop * 1.05, "SHORT gap: fill tại open (cao hơn SL)");
});

// ---------------------------------------------------------------------------
test("#2 Liq có mmr; LIQ chặn trước SL -> riskPctPrice = khoảng cách tới liq", () => {
  // ISOLATED, lev 5, mmr 1 -> liq = 95*(1 - 1/5 + 1/100) = 76.95. slPct 25 -> sl = 71.25 (< liq) -> dùng liq.
  const exitAtLiq = k(88, 80, 81, 70, 74); // open 80 > liq -> fill đúng tại liq (không gap)
  const trades = simulateSymbol("T", longPatternSeries([exitAtLiq]), 100, 25, {}, 5, "ISOLATED", "PRICE", 1);
  assert.equal(trades.length, 1);
  const tr = trades[0];
  assert.equal(tr.reason, "LIQ", "LIQ phải chặn trước SL");
  assert.ok(approx(tr.exitPrice, 76.95, 0.01), `exit ${tr.exitPrice} phải ≈ liq 76.95`);
  // riskPctPrice tới liq = (95-76.95)/95*100 = 19.0% (KHÔNG phải slPct 25, và khác 20% nếu bỏ mmr).
  assert.ok(approx(tr.riskPctPrice!, 19.0, 0.05), `riskPctPrice ${tr.riskPctPrice} phải ≈ 19.0 (có mmr)`);
});

// ---------------------------------------------------------------------------
test("#3 DD bắt đáy MAE rơi GIỮA 2 mốc ngày (timeline sự kiện)", () => {
  // 1 lệnh: MAE -40% tại +12h (giữa mốc ngày 0 và 1), thoát hoà. usdtPerPct = 10 -> đáy equity 600.
  const tr = mkTrade({
    entryTime: T0, exitTime: T0 + 5 * DAY, pnlPct: 0,
    maePct: -40, maeTime: T0 + 12 * HOUR, mfePct: 0, mfeTime: T0,
  });
  const pf = simulatePortfolio([tr], {
    initialCapital: 1000, orderSize: 1000, positionSizePct: 0, leverage: 1,
    riskPerTradePct: 0, riskCompound: false, compounding: false, startTime: T0, endTime: T0 + 5 * DAY,
  });
  // Đáy tại +12h không nằm trên lưới ngày -> chỉ engine timeline sự kiện mới bắt được 40%.
  assert.ok(approx(pf.maxDrawdownPct, 40, 0.01), `MaxDD ${pf.maxDrawdownPct} phải = 40 (bắt đáy MAE giữa ngày)`);
});

test("#4 MFE tạo peak giữa lệnh -> DD mới > DD (chỉ MAE)", () => {
  // entry(0) -> MAE(-5%, +1d) -> MFE(+50%, +3d) -> exit hoà(+5d). Peak equity 1500 -> đáy 1000 -> DD 33.33%.
  const tr = mkTrade({
    entryTime: T0, exitTime: T0 + 5 * DAY, pnlPct: 0,
    maePct: -5, maeTime: T0 + 1 * DAY, mfePct: 50, mfeTime: T0 + 3 * DAY,
  });
  const pf = simulatePortfolio([tr], {
    initialCapital: 1000, orderSize: 1000, positionSizePct: 0, leverage: 1,
    riskPerTradePct: 0, riskCompound: false, compounding: false, startTime: T0, endTime: T0 + 5 * DAY,
  });
  // Nếu chỉ có MAE (không MFE) thì peak = 1000, DD chỉ 5%. Có MFE -> peak 1500 -> DD 33.33% > 5%.
  assert.ok(pf.maxDrawdownPct > 5, "DD mới phải lớn hơn DD chỉ-MAE (5%)");
  assert.ok(approx(pf.maxDrawdownPct, 33.33, 0.05), `MaxDD ${pf.maxDrawdownPct} phải ≈ 33.33`);
});

// ---------------------------------------------------------------------------
test("#5 Sortino: đối chiếu giá trị tính tay (downside dev ÷ n)", () => {
  // 4 lệnh tuần tự, mỗi lệnh mở & đóng gọn trong 1 ngày -> equity ngày = [1000,1020,1010,1040,1020].
  const usd = 10; // orderSize 1000, lev 1 -> usdtPerPct 10 -> pnlPct% * 10 = pnlUsdt
  void usd;
  const day = (n: number, pnlPct: number) =>
    mkTrade({ entryTime: T0 + n * DAY + HOUR, exitTime: T0 + n * DAY + 2 * HOUR, pnlPct });
  const trades = [day(0, 2), day(1, -1), day(2, 3), day(3, -2)];
  const pf = simulatePortfolio(trades, {
    initialCapital: 1000, orderSize: 1000, positionSizePct: 0, leverage: 1,
    riskPerTradePct: 0, riskCompound: false, compounding: false, startTime: T0, endTime: T0 + 4 * DAY,
  });
  // returns: 0.02, -0.0098039, 0.0297030, -0.0192308 ; mean=0.00516707
  // dsd = sqrt((r2^2+r4^2)/4) = 0.01079281 ; sortino = mean/dsd*sqrt(365) ≈ 9.146
  assert.ok(pf.sortino !== null, "Sortino không được null ở đây");
  assert.ok(approx(pf.sortino!, 9.146, 0.05), `Sortino ${pf.sortino} phải ≈ 9.15 (÷n, KHÁC 6.47 nếu ÷downside.length)`);
});

test("#5b Sortino/Sharpe null khi không có biến động", () => {
  // Tất cả return = 0 -> std = 0, downside = 0 -> cả hai null.
  const trades = [
    mkTrade({ entryTime: T0 + HOUR, exitTime: T0 + 2 * HOUR, pnlPct: 0 }),
    mkTrade({ entryTime: T0 + DAY + HOUR, exitTime: T0 + DAY + 2 * HOUR, pnlPct: 0 }),
  ];
  const pf = simulatePortfolio(trades, {
    initialCapital: 1000, orderSize: 100, positionSizePct: 0, leverage: 1,
    riskPerTradePct: 0, riskCompound: false, compounding: false, startTime: T0, endTime: T0 + 2 * DAY,
  });
  assert.equal(pf.sharpe, null);
  assert.equal(pf.sortino, null);
});

// ---------------------------------------------------------------------------
test("#6 Cháy CROSS -> force-close, equity=0 vĩnh viễn, không mở lệnh sau blownAt", () => {
  // Trade A: MAE -120% tại +1d, lev 10 -> unreal -12000 >> vốn -> cháy tại +1d.
  const A = mkTrade({
    symbol: "A", entryTime: T0, exitTime: T0 + 10 * DAY, pnlPct: 5,
    maePct: -120, maeTime: T0 + 1 * DAY,
  });
  // Trade B mở SAU khi cháy (+2d) -> phải bị bỏ (pnlUsdt = 0).
  const B = mkTrade({ symbol: "B", entryTime: T0 + 2 * DAY, exitTime: T0 + 3 * DAY, pnlPct: 10 });
  const pf = simulatePortfolio([A, B], {
    initialCapital: 1000, orderSize: 1000, positionSizePct: 0, leverage: 10,
    riskPerTradePct: 0, riskCompound: false, compounding: false, startTime: T0, endTime: T0 + 11 * DAY,
  });
  assert.equal(pf.accountBlown, true);
  assert.equal(pf.blownAt, T0 + 1 * DAY, "blownAt = thời điểm equity ≤ 0 lần đầu (đáy MAE)");
  assert.equal(pf.finalBalanceUsdt, 0, "equity giữ 0 sau khi cháy");
  assert.ok(approx(pf.maxDrawdownPct, 100, 0.01), "DD = 100% khi cháy");
  assert.equal(pf.cagr, -100, "CAGR = -100 khi finalEq ≤ 0");
  assert.equal(A.pnlUsdt < 0, true, "A bị force-close với lỗ nội suy");
  assert.equal(B.pnlUsdt, 0, "B mở sau blownAt -> không vào lệnh");
});

// ---------------------------------------------------------------------------
test("#7 margin > cash -> co usdtPerPct đúng tỷ lệ cash/margin", () => {
  // vốn 500, orderSize 1000 -> margin clamp về 500, usdtPerPct 10 -> 5. pnlPct +10 -> pnl 50 (không phải 100).
  const tr = mkTrade({ entryTime: T0 + HOUR, exitTime: T0 + 2 * HOUR, pnlPct: 10 });
  const pf = simulatePortfolio([tr], {
    initialCapital: 500, orderSize: 1000, positionSizePct: 0, leverage: 1,
    riskPerTradePct: 0, riskCompound: false, compounding: false, startTime: T0, endTime: T0 + 2 * DAY,
  });
  assert.equal(tr.pnlUsdt, 50, "usdtPerPct co từ 10 -> 5 (×500/1000) -> pnl 50");
  assert.equal(pf.finalBalanceUsdt, 550);
});

// ---------------------------------------------------------------------------
test("#8 Tie-break: cùng timestamp -> kết quả tái lập bất kể thứ tự input", () => {
  const A = mkTrade({ symbol: "AAA", entryPrice: 10, entryTime: T0, exitTime: T0 + 2 * DAY, pnlPct: 5 });
  const B = mkTrade({ symbol: "BBB", entryPrice: 20, entryTime: T0, exitTime: T0 + 2 * DAY, pnlPct: -3 });
  const opts = {
    initialCapital: 1000, orderSize: 400, positionSizePct: 0, leverage: 1,
    riskPerTradePct: 0, riskCompound: false, compounding: false, startTime: T0, endTime: T0 + 3 * DAY,
  };
  const r1 = simulatePortfolio([A, B].map((t) => ({ ...t })), opts);
  const r2 = simulatePortfolio([B, A].map((t) => ({ ...t })), opts);
  const key = (r: typeof r1) => JSON.stringify({
    fin: r.finalBalanceUsdt, dd: r.maxDrawdownPct, eq: r.equityCurveUsdt, pnl: r.totalPnlUsdt,
  });
  assert.equal(key(r1), key(r2), "hai thứ tự input phải cho kết quả giống hệt");
});
