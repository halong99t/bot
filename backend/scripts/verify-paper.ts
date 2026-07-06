/**
 * Kiểm tra vòng đời PAPER auto-trade TREND: tín hiệu → tự mở → trailing → tự cắt.
 * Chạy: npx tsx scripts/verify-paper.ts
 */
import { prisma } from "../src/config/prisma";
import { Kline } from "../src/lib/binance";
import { detectTrendEntry, resolveTrendCfg } from "../src/services/trend.service";
import {
  createTrendSignalAndMaybeTrade,
  monitorTrendPositions,
  getSettings,
} from "../src/services/trading.service";
import { getCurrentRegime } from "../src/services/liveRegime.service";

// Sinh chuỗi nến 1h tăng dần (LONG breakout ở nến cuối): EMA20>50>200, close>EMA200, ADX cao, vượt Donchian.
function risingKlines(n: number): Kline[] {
  const out: Kline[] = [];
  let p = 100;
  const t0 = Date.UTC(2026, 0, 1);
  for (let i = 0; i < n; i++) {
    const open = p;
    const close = p * 1.008;
    const high = close * 1.005;
    const low = open * 0.997;
    out.push({ openTime: t0 + i * 3_600_000, open, high, low, close, volume: 1000, closeTime: t0 + i * 3_600_000 + 3_599_999 });
    p = close;
  }
  return out;
}

async function main() {
  const cfg = resolveTrendCfg({ allowLong: true, allowShort: true });

  // 1) detectTrendEntry (thuần) trên chuỗi breakout
  const kl = risingKlines(260);
  const entry = detectTrendEntry(kl, cfg, "LONG");
  console.log("1) detectTrendEntry:", entry ? `${entry.side} @ ${entry.entry.toFixed(2)} stop=${entry.stop.toFixed(2)} atr=${entry.atr.toFixed(3)} adx=${entry.adx.toFixed(1)}` : "null ❌");
  if (!entry) throw new Error("Không phát hiện breakout — kiểm tra lại điều kiện");

  // 2) Bật chế độ paper TREND + autoTrade
  const s = await getSettings();
  await prisma.settings.update({
    where: { id: s.id },
    data: { strategyMode: "TREND", paperTrade: true, autoTrade: true, riskPerTradePct: 0.5, leverage: 5 },
  });
  const regime = await getCurrentRegime();
  console.log("2) Regime BTC hiện tại:", regime);

  // 3) Dọn dữ liệu test cũ + tạo coin test
  await prisma.trade.deleteMany({ where: { symbol: "TESTUSDT" } });
  await prisma.position.deleteMany({ where: { symbol: "TESTUSDT" } });
  await prisma.signal.deleteMany({ where: { symbol: "TESTUSDT" } });
  const coin = await prisma.coin.upsert({
    where: { symbol: "TESTUSDT" },
    update: {},
    create: { symbol: "TESTUSDT", baseAsset: "TEST", quoteAsset: "USDT", qtyPrecision: 3, pricePrecision: 2 },
  });

  // Mở lệnh theo ĐÚNG chiều regime để không bị FLIP đóng ngay (test trailing).
  const long = regime !== "SHORT";
  const px0 = 100;
  const atr = 1;
  const testEntry = {
    side: (long ? "LONG" : "SHORT") as "LONG" | "SHORT",
    entry: px0,
    stop: long ? px0 - cfg.k1Atr * atr : px0 + cfg.k1Atr * atr,
    atr,
    adx: 30,
    reason: "test",
  };
  await createTrendSignalAndMaybeTrade(coin.id, "TESTUSDT", testEntry, coin.qtyPrecision);
  let pos = await prisma.position.findFirst({ where: { symbol: "TESTUSDT", status: "OPEN" } });
  console.log("3) Vị thế mở:", pos ? `${pos.side} paper=${pos.paper} entry=${pos.entryPrice} qty=${pos.quantity} stop=${pos.stopLoss.toFixed(3)} atrEntry=${pos.atrEntry}` : "KHÔNG MỞ ❌");
  if (!pos) throw new Error("Paper position không mở");

  // 4) Trailing: giá đi thuận lợi mạnh -> stop ratchet
  const favor = long ? px0 * 1.1 : px0 * 0.9; // +10% thuận lợi
  await monitorTrendPositions(new Map([["TESTUSDT", favor]]), cfg.k2Atr);
  pos = await prisma.position.findFirst({ where: { symbol: "TESTUSDT", status: "OPEN" } });
  console.log(`4) Sau khi giá tới ${favor}: stop dời tới ${pos?.stopLoss.toFixed(3)} (trailing ${long ? "lên" : "xuống"}), highWater=${pos?.highWater}`);

  // 5) Giá quay đầu chạm trailing stop -> tự cắt (TRAIL)
  const hitStop = pos!.stopLoss;
  const revert = long ? hitStop - 0.5 : hitStop + 0.5;
  await monitorTrendPositions(new Map([["TESTUSDT", revert]]), cfg.k2Atr);
  const closed = await prisma.position.findFirst({ where: { symbol: "TESTUSDT" }, orderBy: { id: "desc" } });
  const trade = await prisma.trade.findFirst({ where: { symbol: "TESTUSDT" }, orderBy: { id: "desc" } });
  console.log(`5) Sau khi giá về ${revert.toFixed(3)}: vị thế status=${closed?.status}, trade=${trade ? `${trade.closeReason} pnl=${trade.pnl.toFixed(2)} paper=${trade.paper}` : "KHÔNG CÓ ❌"}`);

  console.log(closed?.status === "CLOSED" && trade ? "\n✅ PAPER LIFECYCLE OK (mở → trailing → tự cắt)" : "\n❌ CHƯA ĐÓNG ĐÚNG");

  // Dọn dẹp
  await prisma.trade.deleteMany({ where: { symbol: "TESTUSDT" } });
  await prisma.position.deleteMany({ where: { symbol: "TESTUSDT" } });
  await prisma.signal.deleteMany({ where: { symbol: "TESTUSDT" } });
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
