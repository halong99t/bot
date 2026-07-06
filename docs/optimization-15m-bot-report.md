# Báo cáo Tối ưu "Bot vận hành thực tế" — Timeframe 15m

> **Tư duy:** tối ưu cho bot giao dịch hằng ngày (theo dõi/điều chỉnh liên tục), KHÔNG phải max lợi nhuận 1 năm.
> **Timeframe:** 15m (regimeMode `BTC1H_ALT15M`: regime BTC 1h → đánh alt 15m). **Universe:** 8 coin cố định.
> **Cửa sổ:** 6 tháng gần nhất (2026-01 → 07). **Phương pháp:** GA, direction (L/S/LS) là gene.
> **Fitness (KHÔNG dùng Total Return):** 40% PF · 20% DD · 15% Expectancy · 10% Sharpe · 5% Sortino · 5% Trade-Freq · 5% **Stability** (nghịch đảo phương sai PF theo tuần).
> **Ngày:** 2026-07-05.

---

## 0. Kết luận nhanh
- **Chiều tốt nhất trên 15m (6 tháng qua) = LONG.** Short-only thua rõ (PF 0.70, expR −0.1) vì giai đoạn này thiên tăng.
- **Winner: LONG-only**, PF 1.30 · **MaxDD 7.2%** · Sharpe 1.32 · coverage tuần **100%** (~8.6 lệnh/tuần, hold ~9h) — đúng tiêu chí "tuần nào cũng có lệnh, DD thấp, ổn định".
- **Bỏ coin yếu (BTC/SOL/BNB/TRX) → tốt hơn hẳn:** rổ 4 coin mạnh (ETH/XRP/HYPE/DOGE) đạt **PF 1.51 · DD 4.2% · Sharpe 1.81 · expR 0.20**.

---

## 1. Cấu hình winner (LONG · 15m)
```json
{ "regimeMode":"BTC1H_ALT15M", "symbols": 8 coin (hoặc 4 coin mạnh),
  "allowLong":true, "allowShort":false,
  "dcEntry":72, "dcExit":31, "emaFast":10, "emaSlow":48, "emaTrend":170,
  "adxMin":19, "atrPeriod":10, "k1Atr":3.43, "k2Atr":4.57, "timeStopBars":1820,
  "atrPctMin":0.53, "atrPctMax":8.1, "cooldownBars":6,
  "useDonchianExit":true, "useRegimeExit":true,
  "regimeEmaPeriod":50, "useRegimeBreadth":false, "useRegimeSlope":false,
  "riskPerTradePct":0.45, "compounding":false, "maxConcurrentPositions":6,
  "ddHaltPct":30, "leverage":10 }
```
Regime EMA50 (nhạy) + hard stop 3.4·ATR + trail 4.6·ATR + Donchian-exit + regime-exit + cooldown 6 nến. Risk 0.45%/lệnh (thấp → DD nhỏ).

## 2. So 3 chiều (cùng tham số, rổ 8 coin)
| Chiều | PF | MaxDD | WR | expR | weekPF | Stability | Cov tuần | Lệnh |
|-------|----|-------|----|----|--------|-----------|----------|------|
| **LONG** | **1.30** | **7.2%** | 36.6% | 0.11 | 1.72 | 0.51 | **1.00** | 224 |
| SHORT | 0.70 | 23.4% | 32.4% | −0.10 | 0.78 | 0.45 | 0.96 | 333 |
| Long+Short | (kém hơn Long do Short kéo xuống) | | | | | | | |

→ **LONG-only** là lựa chọn rõ ràng cho 6 tháng qua.

## 3. Per-coin — chiều tốt nhất từng coin (winner params) ⭐
| Coin | LONG PF (lệnh) | SHORT PF (lệnh) | Nên đánh |
|------|----------------|-----------------|----------|
| **HYPEUSDT** | **1.98** (62) | 0.45 (75) | **LONG** ⭐ mạnh nhất |
| **ETHUSDT** | **1.20** (36) | 0.88 (52) | **LONG** |
| **XRPUSDT** | **1.16** (27) | 0.64 (47) | **LONG** |
| **DOGEUSDT** | **1.16** (34) | 0.84 (50) | **LONG** |
| SOLUSDT | 0.74 (42) | 0.75 (59) | (yếu cả 2 → loại) |
| BNBUSDT | 0.56 (10) | 0.76 (27) | (yếu → loại) |
| BTCUSDT | 0.54 (18) | 0.59 (31) | (yếu cả 2 → loại) |
| TRXUSDT | — (0) | 999 (1) | (gần như không giao dịch → loại) |

→ **4 coin đáng đánh LONG: ETH, XRP, HYPE, DOGE.** BTC/SOL/BNB PF<0.8 cả 2 chiều; TRX gần như không có tín hiệu ở khung 15m với bộ này.

## 4. Rổ gốc vs rổ curated
| Rổ | PF | MaxDD | WR | expR | Sharpe | ROI 6m | Lệnh |
|----|----|-------|----|----|--------|--------|------|
| 8 coin | 1.30 | 7.2% | 36.6% | 0.11 | 1.32 | +12% | 224 |
| **4 coin mạnh (ETH/XRP/HYPE/DOGE)** | **1.51** | **4.2%** | 38.4% | **0.20** | **1.81** | +15% | 159 |

→ **Loại coin yếu cải thiện mọi chỉ số** (PF ↑, DD ↓ gần một nửa, Sharpe ↑) — đúng cách trader vận hành: cắt coin underperform.

## 5. Ổn định theo tuần / tháng (winner, rổ 8 coin)
**Monthly PF:** 2026-01: 1.35 · 02: 1.78 · 03: 0.74 · 04: 1.58 · 05: 1.91 · 06: 0.99 · 07: 4.14
→ 5/7 tháng PF>1, chỉ tháng 3 (chop) <1. Coverage 100% tuần.
**Weekly PF:** dao động 0–5.4 (sd 1.67 / mean 1.72, stability 0.51) — tuần nào cũng có lệnh nhưng PF biến động (đặc tính khung 15m nhiễu; cần theo dõi/điều chỉnh — đúng bối cảnh bot vận hành hằng ngày).

## 6. Khuyến nghị vận hành bot (15m)
1. **Chiều: LONG-only** trong regime hiện tại. Theo dõi: khi BTC vào downtrend rõ, bật lại đánh giá Short (bot hỗ trợ switch L/S/LS).
2. **Universe: 4 coin ETH/XRP/HYPE/DOGE** (bỏ BTC/SOL/BNB/TRX cho đến khi chúng cải thiện).
3. **Rà lại tham số hàng tuần/tháng** — bộ này tối ưu 6 tháng gần nhất; khi PF tuần tụt liên tục < 1, chạy lại optimizer.
4. Risk 0.45%/lệnh, leverage x10 (đã có mô hình thanh lý; 0 thanh lý ở mức này), DD-halt 30%.

## 7. Minh bạch / giới hạn
- Tối ưu **in-sample 6 tháng**; khung 15m nhiễu hơn → PF tuần biến động (stability 0.5). Đây là lý do phải theo dõi & tinh chỉnh (đúng như yêu cầu).
- Direction/coin selection dựa trên 6 tháng vừa qua (thiên tăng) → Short yếu là do bối cảnh, không phải Short vô dụng vĩnh viễn.
- Leverage x10 có mô hình thanh lý (mới thêm); phí/slippage mặc định; universe cố định.
- Toàn bộ ~108 cấu hình + per-coin: `backend/_optbot_result.json`.
</content>
