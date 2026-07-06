/**
 * TRADE FORENSICS — phân tích pháp y toàn bộ lệnh (KHÔNG tối ưu tham số).
 * Bộ tham số CỐ ĐỊNH = winner 1H long+short 12m (backend/_opt12m_result.json rank1).
 * Chạy: npx tsx tools/trade-forensics.ts
 *
 * Sản phẩm: bảng đặc trưng từng lệnh, phân nhóm nguyên nhân THUA, đặc điểm lệnh THẮNG,
 * thống kê %, phân cụm (PF theo cụm), phản-thực (bỏ nhóm → PF/Exp thay đổi). Ghi _forensics.json.
 */
import {
  runTrendLocal1mBacktest, getLocalSeriesForSymbol, getFundingCached,
  getLocalDataRange, type TrendBacktestParams, type BacktestResult,
} from "../src/services/backtest.service";
import type { BacktestTrade } from "../src/services/backtest.service";
import { emaSeries, atrSeries, adxSeries, donchianHighSeries, donchianLowSeries, smaSeries } from "../src/services/indicators";
import type { Kline } from "../src/lib/binance";
import fs from "fs";

const UNIVERSE = ["BTCUSDT", "ETHUSDT", "BNBUSDT", "SOLUSDT", "XRPUSDT", "DOGEUSDT", "TRXUSDT", "HYPEUSDT"];
const HOUR = 3_600_000;

// ===== Bộ tham số CỐ ĐỊNH (không đụng tới) =====
const FIXED: TrendBacktestParams = {
  regimeMode: "BTC1H_ALT1H", regimeSource: "local", symbols: UNIVERSE,
  allowLong: true, allowShort: true, initialCapitalUsdt: 10000, marginMode: "CROSS",
  riskCompound: true, compounding: false, leverage: 5, useLiquidation: true,
  dcEntry: 43, dcExit: 25, emaFast: 13, emaSlow: 72, emaTrend: 162, adxMin: 19, atrPeriod: 16,
  k1Atr: 3.23, k2Atr: 4.3, timeStopBars: 514, atrPctMin: 0.33, atrPctMax: 7.1, cooldownBars: 14,
  useDonchianExit: false, useRegimeExit: true, regimeEmaPeriod: 50,
  useRegimeSlope: true, useRegimeBreadth: true, regimeBreadthMin: 0.51,
  riskPerTradePct: 0.52, maxConcurrentPositions: 12, ddHaltPct: 20,
  useCorrelationCap: true, maxPerCluster: 2, corrThreshold: 0.72,
  months: 12,
};
// Round 2: chạy `npx tsx tools/trade-forensics.ts confirm-short` để phân tích hệ SAU cải tiến R1.
if (process.argv.includes("confirm-short")) { FIXED.confirmBars = 1; FIXED.confirmAtr = 0.2; FIXED.confirmSide = "short"; }

interface Feat {
  coin: string; side: "LONG" | "SHORT"; entryTime: number; exitTime: number;
  pnlPct: number; rMultiple: number; holdHours: number; reason: string;
  win: boolean;
  adx: number; atrPct: number; volRatio: number;
  trendDist: number;      // (close−emaTrend)/atr — xa trend nền bao nhiêu ATR
  emaSpread: number;      // (emaFast−emaSlow)/atr — độ dốc cấu trúc
  trendSlope: number;     // (emaTrend−emaTrend[−20])/atr — hướng trend nền
  extension: number;      // (close−emaFast)/atr — mua đuổi cách EMA nhanh bao nhiêu ATR
  breakoutAtr: number;    // (close−donHigh)/atr — vượt kênh mạnh cỡ nào
  volExp: number;         // atr/atr[−20] — vol đang giãn (>1) hay co (<1)
  fundingAnnPct: number;  // funding năm hoá (%)
  fundingAdverse: number; // funding NĂM HOÁ nghịch với vị thế (%, dương = đám đông cùng chiều → rủi ro đảo)
  btcTrend: number;       // (BTC−emaBTC50)/BTC*100 — sức mạnh regime nền
  closeStrength: number;  // vị trí close trong biên nến breakout (1=đóng ở cực thuận, 0=đóng ngược) — lọc fake
  nextConfirm: number;    // nến KẾ có đi tiếp hướng vào lệnh không: (close[i+1]−close[i])/atr theo chiều
  mfeR: number; maeR: number;
}

function nearestFunding(fund: { time: number; rate: number }[], t: number): number {
  // rate gần nhất có time ≤ t (funding 8h)
  let lo = 0, hi = fund.length - 1, ans = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (fund[m].time <= t) { ans = m; lo = m + 1; } else hi = m - 1; }
  return ans >= 0 ? fund[ans].rate : 0;
}

async function main() {
  const range = (await getLocalDataRange())!;
  console.log(`Data tới ${new Date(range.maxTs).toISOString().slice(0, 10)} · 1H · rổ 8 coin · LONG+SHORT · params CỐ ĐỊNH`);
  console.log(`FIXED: DC${FIXED.dcEntry}/${FIXED.dcExit} EMA${FIXED.emaFast}/${FIXED.emaSlow}/${FIXED.emaTrend} ADX>${FIXED.adxMin} k1 ${FIXED.k1Atr}/k2 ${FIXED.k2Atr} regEMA${FIXED.regimeEmaPeriod}+slope+breadth lev x${FIXED.leverage}\n`);

  const res: BacktestResult = await runTrendLocal1mBacktest(FIXED);
  console.log(`BASELINE: ${res.totalTrades} lệnh · WR ${res.winRate.toFixed(1)}% · ROI ${res.roiPct}% · DD ${res.maxDrawdownPct}% · PF ${res.profitFactor} · Sharpe ${res.sharpe} · Sortino ${res.sortino} · Calmar ${res.calmar} · ExpR ${res.expectancyR} · hold ${res.avgHoldingHours ?? "?"}h`);

  // ---- Dựng series + funding cho từng coin ----
  const per: Record<string, {
    kl: Kline[]; idx: Map<number, number>;
    emaF: number[]; emaS: number[]; emaT: number[]; atr: number[]; adx: number[];
    donHi: number[]; volSma: number[]; fund: { time: number; rate: number }[];
  }> = {};
  // BTC cho regime strength
  const btc = await getLocalSeriesForSymbol("BTCUSDT", "1h");
  const btcClose = btc.map((k) => k.close); const btcEma = emaSeries(btcClose, 50);
  const btcIdx = new Map<number, number>(); btc.forEach((k, i) => btcIdx.set(k.openTime, i));
  const btcTrendAt = (t: number) => {
    // nến BTC có openTime ≤ t gần nhất
    let lo = 0, hi = btc.length - 1, ans = -1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (btc[m].openTime <= t) { ans = m; lo = m + 1; } else hi = m - 1; }
    if (ans < 0 || !Number.isFinite(btcEma[ans])) return 0;
    return ((btc[ans].close - btcEma[ans]) / btc[ans].close) * 100;
  };

  for (const sym of UNIVERSE) {
    const kl = await getLocalSeriesForSymbol(sym, "1h");
    if (!kl.length) continue;
    const close = kl.map((k) => k.close);
    const idx = new Map<number, number>(); kl.forEach((k, i) => idx.set(k.openTime, i));
    let fund: { time: number; rate: number }[] = [];
    try { fund = await getFundingCached(sym, kl[0].openTime, kl[kl.length - 1].openTime); } catch { /* funding optional */ }
    per[sym] = {
      kl, idx,
      emaF: emaSeries(close, FIXED.emaFast!), emaS: emaSeries(close, FIXED.emaSlow!), emaT: emaSeries(close, FIXED.emaTrend!),
      atr: atrSeries(kl, FIXED.atrPeriod!), adx: adxSeries(kl, 14),
      donHi: donchianHighSeries(kl, FIXED.dcEntry!), volSma: smaSeries(kl.map((k) => k.volume), 20), fund,
    };
  }

  // ---- Trích đặc trưng từng lệnh ----
  const feats: Feat[] = [];
  let missing = 0;
  for (const t of res.trades as BacktestTrade[]) {
    const p = per[t.symbol]; if (!p) { missing++; continue; }
    const i = p.idx.get(t.entryTime); if (i == null || !Number.isFinite(p.atr[i]) || p.atr[i] <= 0) { missing++; continue; }
    const c = p.kl[i]; const a = p.atr[i]; const long = t.side === "LONG";
    const donHi = long ? p.donHi[i] : donchianLowSeries(p.kl, FIXED.dcEntry!)[i]; // short dùng donLow
    const volSma = p.volSma[i]; const volRatio = Number.isFinite(volSma) && volSma > 0 ? c.volume / volSma : 1;
    const rate = nearestFunding(p.fund, t.entryTime);
    const fundingAnn = rate * 3 * 365 * 100; // 3 lần/ngày
    const riskPct = t.riskPctPrice && t.riskPctPrice > 0 ? t.riskPctPrice : Math.abs(a * FIXED.k1Atr! / c.close) * 100;
    feats.push({
      coin: t.symbol, side: t.side, entryTime: t.entryTime, exitTime: t.exitTime,
      pnlPct: t.pnlPct, rMultiple: riskPct > 0 ? t.pnlPct / riskPct : 0, holdHours: t.barsHeld ?? 0, reason: t.reason,
      win: t.pnlPct > 0,
      adx: Number.isFinite(p.adx[i]) ? p.adx[i] : 0,
      atrPct: (a / c.close) * 100,
      volRatio,
      trendDist: (c.close - p.emaT[i]) / a * (long ? 1 : -1),
      emaSpread: (p.emaF[i] - p.emaS[i]) / a * (long ? 1 : -1),
      trendSlope: i >= 20 && Number.isFinite(p.emaT[i - 20]) ? (p.emaT[i] - p.emaT[i - 20]) / a * (long ? 1 : -1) : 0,
      extension: (c.close - p.emaF[i]) / a * (long ? 1 : -1),
      breakoutAtr: Number.isFinite(donHi) ? (long ? c.close - donHi : donHi - c.close) / a : 0,
      volExp: i >= 20 && Number.isFinite(p.atr[i - 20]) && p.atr[i - 20] > 0 ? a / p.atr[i - 20] : 1,
      fundingAnnPct: fundingAnn,
      fundingAdverse: long ? fundingAnn : -fundingAnn, // dương = phải trả funding (đám đông cùng chiều)
      btcTrend: btcTrendAt(t.entryTime),
      closeStrength: c.high > c.low ? (long ? (c.close - c.low) : (c.high - c.close)) / (c.high - c.low) : 0.5,
      nextConfirm: i + 1 < p.kl.length && a > 0 ? (p.kl[i + 1].close - c.close) / a * (long ? 1 : -1) : 0,
      mfeR: riskPct > 0 ? t.mfePct / riskPct : 0,
      maeR: riskPct > 0 ? t.maePct / riskPct : 0,
    });
  }
  console.log(`Trích đặc trưng: ${feats.length}/${res.totalTrades} lệnh (bỏ ${missing} không map được).\n`);

  // ================= PHÂN NHÓM NGUYÊN NHÂN THUA =================
  const losers = feats.filter((f) => !f.win);
  const winners = feats.filter((f) => f.win);
  // Gán MỖI lệnh thua vào 1 nguyên nhân CHÍNH (thứ tự ưu tiên).
  function lossCause(f: Feat): string {
    if (f.mfeR < 0.5 && f.holdHours <= 24) return "FAKE_BREAKOUT";      // vào rồi đảo ngay, chưa từng có lời
    if (f.reason === "FLIP") return "REGIME_FLIP";                        // regime lật → trend chết
    if (f.mfeR >= 1.5) return "GAVE_BACK_WINNER";                         // đã lời ≥1.5R rồi trả hết
    if (f.adx < 22) return "WEAK_TREND_ADX";                             // ADX thấp lúc vào
    if (f.extension >= 4) return "LATE_EXTENDED";                         // mua đuổi quá xa EMA nhanh
    if (f.volRatio < 1.0) return "NO_VOLUME_CONFIRM";                     // volume không xác nhận
    if (f.reason === "TIME") return "CHOP_TIMESTOP";                      // đứng im hết time-stop
    if (Math.abs(f.fundingAdverse) >= 30 && f.fundingAdverse > 0) return "FUNDING_CROWDED";
    if (f.atrPct < 0.6) return "VOL_TOO_SMALL";                          // biến động chết
    return "OTHER";
  }
  const causeMap = new Map<string, Feat[]>();
  for (const f of losers) { const c = lossCause(f); (causeMap.get(c) ?? causeMap.set(c, []).get(c)!).push(f); }

  const pct = (n: number, d: number) => d ? (100 * n / d).toFixed(1) + "%" : "—";
  const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);
  const mean = (a: number[]) => a.length ? sum(a) / a.length : 0;
  const pf = (fs: Feat[]) => { const w = sum(fs.filter((f) => f.pnlPct > 0).map((f) => f.pnlPct)); const l = -sum(fs.filter((f) => f.pnlPct <= 0).map((f) => f.pnlPct)); return l > 0 ? w / l : w > 0 ? 999 : 0; };
  const wr = (fs: Feat[]) => pct(fs.filter((f) => f.win).length, fs.length);

  console.log(`===== PHÂN NHÓM NGUYÊN NHÂN THUA (${losers.length} lệnh thua / ${feats.length}) =====`);
  const causeRows = [...causeMap.entries()].map(([c, fs]) => ({
    cause: c, n: fs.length, pctLoss: 100 * fs.length / losers.length,
    sumPnl: sum(fs.map((f) => f.pnlPct)), avgR: mean(fs.map((f) => f.rMultiple)),
    avgAdx: mean(fs.map((f) => f.adx)), avgVol: mean(fs.map((f) => f.volRatio)), avgHold: mean(fs.map((f) => f.holdHours)),
  })).sort((a, b) => b.n - a.n);
  for (const r of causeRows)
    console.log(`  ${r.cause.padEnd(18)} ${String(r.n).padStart(3)} lệnh (${r.pctLoss.toFixed(1).padStart(5)}% thua) · Σpnl ${r.sumPnl.toFixed(1).padStart(7)}% · avgR ${r.avgR.toFixed(2).padStart(6)} · ADX ${r.avgAdx.toFixed(0)} · vol× ${r.avgVol.toFixed(2)} · hold ${r.avgHold.toFixed(0)}h`);

  // ================= ĐẶC ĐIỂM LỆNH THẮNG vs THUA =================
  console.log(`\n===== THẮNG (${winners.length}) vs THUA (${losers.length}) — trung bình đặc trưng =====`);
  const cmp = (name: string, sel: (f: Feat) => number, d = 2) =>
    console.log(`  ${name.padEnd(16)} THẮNG ${mean(winners.map(sel)).toFixed(d).padStart(8)} | THUA ${mean(losers.map(sel)).toFixed(d).padStart(8)}`);
  cmp("ADX", (f) => f.adx, 1); cmp("ATR%", (f) => f.atrPct); cmp("volRatio", (f) => f.volRatio);
  cmp("trendDist(ATR)", (f) => f.trendDist); cmp("emaSpread(ATR)", (f) => f.emaSpread); cmp("trendSlope", (f) => f.trendSlope);
  cmp("extension(ATR)", (f) => f.extension); cmp("breakout(ATR)", (f) => f.breakoutAtr); cmp("volExp", (f) => f.volExp);
  cmp("funding ann%", (f) => f.fundingAnnPct, 1); cmp("fundingAdverse", (f) => f.fundingAdverse, 1);
  cmp("btcTrend%", (f) => f.btcTrend); cmp("closeStrength", (f) => f.closeStrength); cmp("nextConfirm", (f) => f.nextConfirm);
  cmp("holdHours", (f) => f.holdHours, 0); cmp("MFE(R)", (f) => f.mfeR); cmp("MAE(R)", (f) => f.maeR);

  // Fake-breakout theo CHIỀU + phân biệt bằng closeStrength/nextConfirm
  const fakes = losers.filter((f) => f.mfeR < 0.5 && f.holdHours <= 24);
  const fakeLong = fakes.filter((f) => f.side === "LONG"), fakeShort = fakes.filter((f) => f.side === "SHORT");
  console.log(`\n  FAKE_BREAKOUT theo chiều: LONG ${fakeLong.length}/${winners.concat(losers).filter((f) => f.side === "LONG").length} · SHORT ${fakeShort.length}/${feats.filter((f) => f.side === "SHORT").length}`);
  console.log(`  closeStrength: winners ${mean(winners.map((f) => f.closeStrength)).toFixed(2)} | fakes ${mean(fakes.map((f) => f.closeStrength)).toFixed(2)} | nextConfirm: winners ${mean(winners.map((f) => f.nextConfirm)).toFixed(2)} | fakes ${mean(fakes.map((f) => f.nextConfirm)).toFixed(2)}`);
  for (const th of [0.5, 0.6, 0.7]) {
    const g = feats.filter((f) => f.closeStrength >= th); console.log(`  closeStrength≥${th}: ${g.length} lệnh · WR ${wr(g)} · PF ${pf(g).toFixed(2)} · expR ${mean(g.map((f) => f.rMultiple)).toFixed(2)}`);
  }
  for (const th of [0, 0.3, 0.6]) {
    const g = feats.filter((f) => f.nextConfirm >= th); console.log(`  nextConfirm≥${th}ATR: ${g.length} lệnh · WR ${wr(g)} · PF ${pf(g).toFixed(2)} · expR ${mean(g.map((f) => f.rMultiple)).toFixed(2)}`);
  }

  // ================= THỐNG KÊ % theo ngưỡng =================
  console.log(`\n===== THỐNG KÊ MẪU =====`);
  for (const th of [19, 22, 25, 28, 32]) {
    const g = feats.filter((f) => f.adx >= th); console.log(`  ADX≥${th}: ${g.length} lệnh · WR ${wr(g)} · PF ${pf(g).toFixed(2)} · expR ${mean(g.map((f) => f.rMultiple)).toFixed(2)}`);
  }
  console.log(`  volRatio≥1.0: ${feats.filter((f) => f.volRatio >= 1).length} lệnh · WR ${wr(feats.filter((f) => f.volRatio >= 1))} · PF ${pf(feats.filter((f) => f.volRatio >= 1)).toFixed(2)}`);
  console.log(`  volRatio<1.0: ${feats.filter((f) => f.volRatio < 1).length} lệnh · WR ${wr(feats.filter((f) => f.volRatio < 1))} · PF ${pf(feats.filter((f) => f.volRatio < 1)).toFixed(2)}`);
  console.log(`  extension<4ATR: PF ${pf(feats.filter((f) => f.extension < 4)).toFixed(2)} | ≥4ATR: PF ${pf(feats.filter((f) => f.extension >= 4)).toFixed(2)}`);
  console.log(`  btcTrend>0: ${feats.filter((f) => f.btcTrend > 0).length} lệnh WR ${wr(feats.filter((f) => f.btcTrend > 0))} PF ${pf(feats.filter((f) => f.btcTrend > 0)).toFixed(2)} | ≤0: ${feats.filter((f) => f.btcTrend <= 0).length} WR ${wr(feats.filter((f) => f.btcTrend <= 0))} PF ${pf(feats.filter((f) => f.btcTrend <= 0)).toFixed(2)}`);
  console.log(`  LONG: ${feats.filter((f) => f.side === "LONG").length} lệnh WR ${wr(feats.filter((f) => f.side === "LONG"))} PF ${pf(feats.filter((f) => f.side === "LONG")).toFixed(2)} | SHORT: ${feats.filter((f) => f.side === "SHORT").length} WR ${wr(feats.filter((f) => f.side === "SHORT"))} PF ${pf(feats.filter((f) => f.side === "SHORT")).toFixed(2)}`);
  console.log(`  (OI: KHÔNG khả dụng — Binance chỉ lưu ~30 ngày OI, không phủ 12m)`);

  // ================= PHÂN CỤM =================
  console.log(`\n===== PHÂN CỤM (mỗi lệnh 1 cụm, ưu tiên) — PF theo cụm =====`);
  function cluster(f: Feat): string {
    if (f.adx < 22) return "D_Weak/Range";
    if (f.extension >= 4) return "F_Extended";
    if (f.volExp >= 1.3) return "E_VolExpansion";
    if (f.adx >= 28) return "A_StrongTrend";
    if (f.breakoutAtr <= 1) return "C_CleanBreakout";
    return "B_NormalBreakout";
  }
  const clMap = new Map<string, Feat[]>();
  for (const f of feats) { const c = cluster(f); (clMap.get(c) ?? clMap.set(c, []).get(c)!).push(f); }
  const clRows = [...clMap.entries()].map(([c, fs]) => ({ c, n: fs.length, wr: 100 * fs.filter((f) => f.win).length / fs.length, pf: pf(fs), expR: mean(fs.map((f) => f.rMultiple)), sumPnl: sum(fs.map((f) => f.pnlPct)) })).sort((a, b) => b.pf - a.pf);
  for (const r of clRows)
    console.log(`  ${r.c.padEnd(18)} ${String(r.n).padStart(3)} lệnh · WR ${r.wr.toFixed(0).padStart(3)}% · PF ${r.pf.toFixed(2).padStart(5)} · expR ${r.expR.toFixed(2).padStart(6)} · Σpnl ${r.sumPnl.toFixed(1).padStart(7)}%`);

  // ================= PHẢN-THỰC (trade-level) =================
  console.log(`\n===== PHẢN-THỰC: bỏ nhóm/thêm bộ lọc → PF & Exp thay đổi (mức TRADE-LEVEL) =====`);
  const base = { pf: pf(feats), expR: mean(feats.map((f) => f.rMultiple)), wr: 100 * winners.length / feats.length, sumPnl: sum(feats.map((f) => f.pnlPct)), n: feats.length };
  console.log(`  BASELINE: PF ${base.pf.toFixed(2)} · expR ${base.expR.toFixed(2)} · WR ${base.wr.toFixed(1)}% · Σpnl ${base.sumPnl.toFixed(1)}% · ${base.n} lệnh`);
  const scenarios: { label: string; keep: (f: Feat) => boolean }[] = [
    { label: "bỏ FAKE_BREAKOUT (mfeR<0.5&≤24h)", keep: (f) => !(f.mfeR < 0.5 && f.holdHours <= 24) },
    { label: "lọc ADX≥22", keep: (f) => f.adx >= 22 },
    { label: "lọc ADX≥25", keep: (f) => f.adx >= 25 },
    { label: "lọc volRatio≥1.0", keep: (f) => f.volRatio >= 1.0 },
    { label: "lọc extension<4ATR", keep: (f) => f.extension < 4 },
    { label: "lọc btcTrend>0 (cùng chiều BTC)", keep: (f) => (f.side === "LONG" ? f.btcTrend > 0 : f.btcTrend < 0) },
    { label: "bỏ SHORT (long-only)", keep: (f) => f.side === "LONG" },
    { label: "lọc funding không quá lệch (|adv|<30%)", keep: (f) => !(f.fundingAdverse >= 30) },
    { label: "COMBO ADX≥22 & vol≥1 & ext<4", keep: (f) => f.adx >= 22 && f.volRatio >= 1 && f.extension < 4 },
  ];
  for (const s of scenarios) {
    const kept = feats.filter(s.keep); const removed = feats.filter((f) => !s.keep(f));
    console.log(`  ${s.label.padEnd(38)} giữ ${String(kept.length).padStart(3)} (bỏ ${String(removed.length).padStart(3)}) → PF ${pf(kept).toFixed(2)} (Δ${(pf(kept) - base.pf >= 0 ? "+" : "")}${(pf(kept) - base.pf).toFixed(2)}) · expR ${mean(kept.map((f) => f.rMultiple)).toFixed(2)} · WR ${(100 * kept.filter((f) => f.win).length / kept.length).toFixed(1)}% · Σpnl ${sum(kept.map((f) => f.pnlPct)).toFixed(1)}% · bỏ-nhóm-PF ${pf(removed).toFixed(2)}`);
  }

  fs.writeFileSync("_forensics.json", JSON.stringify({
    fixed: FIXED, baseline: { totalTrades: res.totalTrades, winRate: res.winRate, roiPct: res.roiPct, maxDrawdownPct: res.maxDrawdownPct, profitFactor: res.profitFactor, sharpe: res.sharpe, sortino: res.sortino, calmar: res.calmar, expectancyR: res.expectancyR },
    causes: causeRows, clusters: clRows, feats,
  }, null, 1));
  console.log(`\nĐã ghi backend/_forensics.json (${feats.length} lệnh, đầy đủ đặc trưng).`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
