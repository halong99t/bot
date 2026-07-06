# 📊 Backtest Engine — Tài liệu kỹ thuật (để audit)

> Mục đích: mô tả **chính xác** cách engine backtest tính toán, để đối chiếu với chuẩn quỹ
> (TradingView / Backtrader / QuantConnect). Mọi công thức dưới đây khớp với code hiện tại.

**File chính:** `backend/src/services/backtest.service.ts`
**Phụ:** `backend/src/lib/binance.ts` (klines, funding), `backend/src/services/strategy.service.ts` (mô hình LONG), `backend/src/services/emaClassifier.service.ts` (EMA).

---

## 1. Luồng tổng thể

```
1) Sinh trade cho từng symbol   -> simulateSymbol() (LONG) | simulateSymbolEmaAlignment() (EMA)
2) Trừ phí + slippage + funding -> buildResult() (đầu hàm)
3) Áp trần vị thế đồng thời      -> applyConcurrencyCap()
4) Mô phỏng danh mục (tiền)      -> simulatePortfolio()  [event-driven]
5) Tính chỉ số % + gộp nhóm      -> buildResult() (cuối hàm)
```

Mọi loại backtest (LONG local/live/imported, EMA) đều đi qua `buildResult()` → dùng chung công thức.

---

## 2. Sinh trade (Entry / Exit / SL / TP / Liquidation)

### 2.1 LONG — `simulateSymbol()`
- **Entry:** khi `detectLongPattern` khớp (giảm ≥15% → sideway ≥20 nến biên độ <5% → 3 nến tăng ≥10% → breakout). Vào tại **close nến breakout** = `klines[i].close`. Không look-ahead (`detectLongPattern` chỉ nhận `slice(0, i+1)`).
- **TP/SL theo giá:**
  - `tpMovePct = tpSlMode==="MARGIN" ? tpPct/leverage : tpPct`
  - `slMovePct = tpSlMode==="MARGIN" ? slPct/leverage : slPct`
  - `tp = entry*(1 + tpMovePct/100)`, `sl = entry*(1 - slMovePct/100)`
- **Liquidation (chỉ ISOLATED, có maintenance margin):** `liq = entry*(1 - 1/leverage + mmr/100)` — `mmr` (`maintenanceMarginRatePct`, mặc định `0.5`) kéo `liq` LẠI GẦN entry hơn → cháy SỚM hơn (bi quan). Nếu `liq > sl` thì chặn tại `liq` (cháy trước SL), reason=`LIQ`.
- **Quét thoát** từ nến `i+1`: trong cùng 1 nến nếu chạm cả SL và TP → **giả định chạm SL/LIQ trước (bi quan)**. Nếu không chạm → thoát tại nến cuối (reason=`EOD`).
- **Gap qua SL/LIQ:** nếu nến **mở** đã vượt mức chặn (`open < sl/liq` cho LONG) → fill tại `open` (tệ hơn mức chặn). **TP là lệnh limit:** open gap thuận lợi qua TP vẫn fill tại `tp` (không lấy bonus) — giữ thiên hướng bi quan.
- **`pnlPct = (exitPrice - entry)/entry * 100`**.
- **`riskPctPrice = (entry − mức chặn thực)/entry*100`** = khoảng cách tới SL, HOẶC tới `liq` nếu LIQ chặn trước SL (không dùng `slMovePct` để Expectancy R không bị nén sai). Dùng cho Expectancy R & sizing rủi ro.
- **MAE** (`maePct`, `maeTime`): giá thấp nhất chạm trong lúc giữ → `maePct = (worstLow - entry)/entry*100 ≤ 0`.
- **MFE** (`mfePct`, `mfeTime`): giá cao nhất chạm trong lúc giữ (điểm thuận lợi nhất) → `mfePct = (bestHigh - entry)/entry*100 ≥ 0`. Dùng dựng đỉnh giữa lệnh cho equity danh mục.
- **`side = "LONG"`**.

### 2.2 EMA — `simulateSymbolEmaAlignment()`
- Hỗ trợ **LONG và SHORT** (`legPnl` đảo dấu cho short), **chốt từng phần** (`fracTP1`, `remaining`), trailing, hard-exit, global-flip.
- MAE tính theo phía bất lợi: `low` (long) / `high` (short); **MFE** theo phía thuận lợi: `high` (long) / `low` (short).
- Gap qua SL/LIQ fill tại open; TP limit fill tại tp (như 2.1).
- Liquidation ISOLATED có `mmr`: adverse move tới liq = `(100/leverage − mmr)%`.
- `riskPctPrice = R/entry*100` (R = |entry − mức chặn thực; liq nếu chặn trước SL). `side` = LONG/SHORT theo state.

> **Giả định quan trọng:** intrabar luôn ưu tiên phía **bất lợi** trước (SL/LIQ trước TP) → backtest thiên về bi quan, tránh thổi phồng lợi nhuận.

---

## 3. Phí, Slippage, Funding — `buildResult()` (đầu hàm)

Tất cả trừ trực tiếp vào `pnlPct` (đều là % trên notional = % biến động giá, nên đòn bẩy triệt tiêu):

```
costPct   = 2 * (feePct + slippagePct)              // round-trip vào + ra
fundingMarks(entry,exit) = floor(exit/8h) - floor(entry/8h)   // số mốc 8h UTC giữ qua, khoảng (entry, exit]
rawFunding = t.fundingPct (thật, nếu useRealFunding)  ||  fundingMarks * fundingRatePctPer8h  (ước lượng)
sideSign   = (side === "SHORT") ? -1 : +1            // LONG trả funding khi rate>0; SHORT nhận
pnlPct    -= costPct + rawFunding * sideSign
```

- **Funding thật** (`useRealFunding=true`, chỉ LONG local): `binance.getFundingRateHistory()` (public), cache đĩa `1m/_cache/_funding/SYMBOL.json`; `t.fundingPct = Σ(rate ở các mốc trong (entry,exit]) × 100`.
- Mặc định: ước lượng `fundingRatePctPer8h = 0.01%`.
- **Phí/slippage mặc định = taker Binance USDT-M:** `feePct = 0.045%`, `slippagePct = 0.02%` mỗi chiều (round-trip = 2×). Mặc định 0/0 cũ cho kết quả ẢO (bỏ qua chi phí giao dịch). Phí tính trên **notional** = % biến động giá (đòn bẩy triệt tiêu).

---

## 4. Trần vị thế đồng thời — `applyConcurrencyCap()`

Duyệt tín hiệu theo thời gian vào; chỉ nhận khi số vị thế đang mở (`exitTime > entryTime` của lệnh đang xét) `< maxConcurrent`. Trả `accepted`, `skipped`, `peak`.
Nếu dùng R-based + `maxPortfolioRiskPct` → `maxConcurrent = min(maxConcurrent, floor(maxPortfolioRiskPct/riskPerTradePct))`.

---

## 5. Engine danh mục (TIỀN) — `simulatePortfolio()`  ⭐

Event-driven trên danh sách sự kiện {mở, đóng} sắp theo thời gian (cùng mốc: **đóng trước, mở sau** để giải phóng margin).

### 5.1 Sizing + khóa margin (tại ENTRY)
```
basis = compounding ? max(0, equityNow) : initialCapital     // compounding = !monthlyReset
// Ký quỹ thường:
margin     = positionSizePct>0 ? basis*(positionSizePct/100) : orderSize
usdtPerPct = margin * leverage / 100                          // lãi/lỗ USDT trên mỗi 1% giá
// Sizing theo rủi ro (nếu riskPerTradePct>0):
riskMoney  = (riskCompound?basis:initialCapital) * riskPerTradePct/100
usdtPerPct = riskMoney / rPct           // rPct = riskPctPrice
margin     = riskMoney / (rPct/100) / leverage
// Khóa margin (không vượt cash):
if (margin > cash) { usdtPerPct *= cash/margin; margin = cash }   // co theo tỷ lệ
if (cash<=0 || margin<=0) -> bỏ lệnh (không mở)
cash -= margin
```

### 5.2 Realize (tại EXIT)
```
pnl  = usdtPerPct * pnlPct        // pnlPct đã trừ phí+funding
cash += margin + pnl              // trả margin + lãi/lỗ
t.pnlUsdt = pnl
```

**Cháy tài khoản (CROSS/ISOLATED):** tại mốc **ĐẦU TIÊN** `Equity(τ) ≤ 0` (kiểm tra ở mọi đỉnh gấp khúc — xem 5.5) → **force-close TOÀN BỘ** vị thế đang mở tại pct nội suy hiện hành (`t.pnlUsdt` = giá trị nội suy), set `equity = 0`, ghi `blownAt = τ`, dừng **vĩnh viễn** (không mở lệnh mới, equity giữ 0 từ đó). Không còn chuyện lệnh đang mở "hồi sinh" tài khoản.

### 5.3 Equity = Balance + Unrealized (mark-to-market)
```
Equity(τ) = cash + Σ_{vị thế mở}( margin + unreal(p, τ) )
unreal(p, τ) = usdtPerPct * pctPathAt(trade, τ)
```
`pctPathAt` = đường %lãi/lỗ theo timeline, **gấp khúc qua CẢ MAE và MFE** theo thứ tự thời gian:
```
entry(0)  →  [MAE(maePct), MFE(mfePct) sắp theo time]  →  exitTime(pnlPct)   (nội suy tuyến tính từng đoạn)
```
Điểm không hợp lệ (thiếu, sai dấu, ngoài `(entry,exit)`) bị bỏ qua; không có điểm giữa nào → tuyến tính thẳng `0 → pnlPct`.
→ Có MFE ⇒ equity tạo **đỉnh giữa lệnh** ⇒ peak không bị thấp giả ⇒ **Max DD không bị đánh giá thấp**. Có MAE ⇒ bắt cú lún giữa lệnh.

### 5.4 Lấy mẫu equity theo NGÀY
`equityDailyUsdt[]` = `Equity(τ)` tại mỗi mốc cách nhau `DAY_MS`, từ `startTime` đến `endTime`. **Chỉ dùng cho Sharpe/Sortino/CAGR/daily returns** — KHÔNG dùng cho Max Drawdown.

### 5.5 Max Drawdown trên TIMELINE SỰ KIỆN ⭐
`Equity(τ)` được đánh giá tại **mọi đỉnh gấp khúc** của đường equity: mốc mở/đóng lệnh + mọi `maeTime`/`mfeTime` của các vị thế. Vì equity là **piecewise-linear**, cực trị luôn nằm tại đỉnh gấp khúc → cách này **chính xác tuyệt đối** cho mô hình nội suy (không bỏ sót đáy MAE rơi giữa 2 mốc ngày). `peak = max(peak, Equity)` (khởi tạo = vốn ban đầu); `maxDrawdownPct = max((peak−Equity)/peak)`, `maxDrawdownUsdt = min(Equity−peak)`.

---

## 6. Công thức các CHỈ SỐ

### Trên equity của engine danh mục (`simulatePortfolio`)
| Chỉ số | Công thức | Trường hợp không xác định |
|---|---|---|
| **Max Drawdown %** | trên **timeline sự kiện** (5.5): `DD = (peak − eq)/peak`, `maxDD = max(DD)` → **∈ [0,100%]** | — |
| **Max Drawdown USDT** | `min(eq − peak)` (âm) trên timeline sự kiện | — |
| **Daily return** | `ret[d] = eq[d]/eq[d-1] − 1` (bỏ qua nếu `eq[d-1] ≤ 0`) | — |
| **Sharpe** | `mean(ret) / std(ret) × √365`, **std MẪU (÷ n−1)**, risk-free = 0 | `std=0` hoặc `n<2` → **`null`** |
| **Sortino** | `mean(ret) / dsd × √365`, `dsd = sqrt(Σ min(ret,0)² / n)` — downside dev trên **TOÀN BỘ** n return | `dsd=0` → **`null`** |
| **CAGR** | `(finalEq/initial)^(1/years) − 1`, `years=(end−start)/365d`; `finalEq ≤ 0` (cháy) → **`−100`** | `years/initial ≤ 0` → `0` |
| **Calmar** | `CAGR% / MaxDD%` | `MaxDD=0` → **`null`** |
| **ROI** | `(finalEq − initial)/initial × 100` | — |

### Theo TIỀN (`simulatePortfolio`, chỉ trên lệnh thực sự mở & đóng)
| Chỉ số | Công thức |
|---|---|
| **Profit Factor (USDT)** | `Σ pnlUsdt⁺ / |Σ pnlUsdt⁻|` (999 nếu không có lệnh lỗ) — khác PF theo % khi có R-sizing/compounding |
| **Avg Win / Avg Loss (USDT)** | `mean(pnlUsdt | win)` / `mean(pnlUsdt | loss)` (avgLoss ≤ 0) |
| **Expectancy (USDT)** | `mean(pnlUsdt)` trên các lệnh đã realize |

### Trên % mỗi lệnh (`buildResult`, độc lập sizing)
| Chỉ số | Công thức |
|---|---|
| **Win Rate** | `#(pnlPct>0) / tổng × 100` (breakeven tính là thua) |
| **Profit Factor** | `Σ pnlPct⁺ / |Σ pnlPct⁻|` (999 nếu không có lệnh lỗ) |
| **Expectancy (R)** | `mean(pnlPct / riskPctPrice)` trên các lệnh có `riskPctPrice>0` |
| **Avg Return** | `Σ pnlPct / tổng lệnh` |
| **Max Consecutive W/L** | chuỗi thắng/thua dài nhất theo thứ tự ĐÓNG lệnh |
| **Avg Holding Time** | `mean(exitTime − entryTime) / 3.6e6` (giờ) |
| **equityCurve (%)** | cumsum `pnlPct` — **chỉ để vẽ sparkline, KHÔNG dùng cho drawdown** |

> **Convention giá trị không xác định:** PF (cả % và USDT) dùng `999` = ∞ (không có lệnh lỗ); Sharpe/Sortino/Calmar dùng `null`. Hai convention song song (không chuẩn hoá về một) — lưu ý khi đọc kết quả.

---

## 7. An toàn / bảo toàn

- **Không âm tài khoản:** margin không vượt cash; cháy (equity ≤ 0) → **force-close toàn bộ, equity = 0 vĩnh viễn** (không hồi sinh, không mở lệnh mới sau `blownAt`).
- **Không double-count:** mỗi lệnh realize đúng 1 lần (tại exit, hoặc tại `blownAt` nếu bị force-close — event đóng sau đó bị bỏ qua).
- **Không look-ahead:** entry tại close nến tín hiệu; quét exit từ nến sau.
- **compounding:** `false` (mặc định) = sizing cố định theo VỐN BAN ĐẦU; `true` = lãi kép theo equity. `monthlyReset` là alias deprecated: `monthlyReset=true ⇒ compounding=false`.
- **months (local):** giới hạn N tháng cuối của dữ liệu (`runLocal1mBacktest` & `runEmaLocal1mBacktest`).
- **Lọc dữ liệu xấu:** bỏ stablecoin + coin flatline/chết (`isLowQualitySymbol`).

---

## 8. XẤP XỈ / GIỚI HẠN ĐÃ BIẾT (cần lưu ý khi audit)

1. **MAE là 1 điểm worst**, không phải full price-path → cú lún giữa lệnh được mô hình bằng đường gấp khúc qua 1 đáy, không phải mọi dao động. Bảo toàn tốt cho drawdown nhưng không tuyệt đối.
2. **Unrealized nội suy theo thời gian** (tuyến tính từng đoạn), không dùng giá thật từng nến (để tránh giữ toàn bộ klines 503 symbol trong RAM).
3. **Funding thật** mới wired cho **LONG local**; EMA / live / imported dùng ước lượng.
4. **Funding ước lượng** là hằng số `0.01%/8h` (điều chỉnh qua `fundingRatePctPer8h`), không phản ánh biến động funding theo symbol/thời điểm.
5. **Sharpe/Sortino** dùng return NGÀY từ equity đã lấy mẫu; equity chỉ đổi tại điểm sự kiện + nội suy → mượt hơn thực tế (có thể hơi lạc quan về độ biến động).
6. **Spread** chưa tách riêng (gộp vào `slippagePct`).
7. **CROSS**: không thanh lý từng lệnh lẻ giữa chừng (chỉ chặn ở SL); nhưng cháy tài khoản (equity ≤ 0) được xét ở **mọi đỉnh gấp khúc** và **force-close toàn bộ** ngay tại `blownAt` (mục 5.2).
8. **Survivorship / look-ahead trong lọc symbol:** `isLowQualitySymbol()` đánh giá trên **toàn bộ** lịch sử file (chưa point-in-time) → coin bị loại được log kèm lý do lúc chạy. Universe = coin đang có mặt trong dữ liệu local; **coin đã delist không có mặt** → kết quả nghiêng **survivorship-bias tích cực**.
9. **Entry tại close nến tín hiệu** (không phải next-bar-open như Backtrader) → **lạc quan hơn** một chút so với chuẩn next-bar-open (giả định fill ngay tại giá đóng nến phát tín hiệu).
10. **Phí chiều ra** tính trên **notional lúc ENTRY** (costPct trừ thẳng vào `pnlPct` = % biến động giá), không tính lại trên notional lúc thoát — xấp xỉ, chênh nhỏ khi giá dịch mạnh.

---

## 9. Tham số đầu vào (BacktestParams) — mặc định

| Tham số | Mặc định | Ý nghĩa |
|---|---|---|
| `initialCapitalUsdt` | 1000 | Vốn ban đầu |
| `orderSizeUsdt` | 50 | Ký quỹ/lệnh (chế độ cố định) |
| `positionSizePct` | 0 (>0 ưu tiên) | Ký quỹ = % equity/vốn |
| `leverage` | 1 | Đòn bẩy |
| `takeProfitPct`/`stopLossPct` | 30 / 15 | TP/SL (theo `tpSlMode`) |
| `tpSlMode` | PRICE | PRICE = %giá; MARGIN = %ký quỹ (÷ đòn bẩy ra %giá) |
| `marginMode` | CROSS | CROSS/ISOLATED (ISOLATED có thanh lý lẻ) |
| `maintenanceMarginRatePct` | 0.5 | Maintenance margin (%) cho giá thanh lý ISOLATED (cháy sớm hơn) |
| `maxConcurrentPositions` | 0 | Trần vị thế đồng thời (0 = không giới hạn) |
| `riskPerTradePct` | 0 | >0 = sizing theo rủi ro (R-based) |
| `feePct`/`slippagePct` | 0.045 / 0.02 | Phí/slippage mỗi chiều (%) — taker Binance USDT-M |
| `fundingRatePctPer8h` | 0.01 | Funding ước lượng mỗi 8h (%) |
| `useRealFunding` | false | Nạp funding lịch sử thật (chỉ LONG local) |
| `compounding` | false | Sizing lãi kép theo equity (true) hay cố định theo vốn ban đầu (false) |
| `monthlyReset` | *(deprecated)* | Alias cũ: `monthlyReset=true ⇒ compounding=false`. Dùng `compounding`. |

---

*Tài liệu này phản ánh trạng thái engine sau audit + refactor event-driven, cập nhật đợt fix P0–P2 (2026-07): MFE trong price-path, Max DD trên timeline sự kiện, force-close khi cháy, Sortino/Sharpe chuẩn + null guards, fee mặc định thực tế, chỉ số theo tiền. Đối chiếu trực tiếp với `buildResult()` và `simulatePortfolio()` trong `backend/src/services/backtest.service.ts`.*
