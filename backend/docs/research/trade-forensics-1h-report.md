# Trade Forensics — Trend Following 1H (Long+Short), 12 tháng

**Vai trò:** Senior Quant Researcher. **Nguyên tắc:** KHÔNG tối ưu tham số (EMA/ATR/ADX/RSI/SL/TP/risk cố định). Chỉ phân tích lệnh và cải tiến **logic vào lệnh**. Mọi kết luận có số liệu backtest.

- **Universe:** BTC ETH BNB SOL XRP DOGE TRX HYPE · **Khung:** 1H · **Chiến lược:** Trend Following Donchian breakout + regime BTC · **Long+Short**
- **Tham số CỐ ĐỊNH** (winner 1H L+S 12m, `_opt12m_result.json` rank1): DC43/25 · EMA13/72/162 · ADX>19 · ATR16 · k1 3.23/k2 4.3 · timeStop514 · regEMA50+slope+breadth · risk0.52% · maxConc12 · corrCap2/0.72 · lev x5.
- **Công cụ:** `tools/trade-forensics.ts` (trích đặc trưng + phân loại + cụm + phản-thực), `tools/filter-eval.ts` (đánh giá cải tiến), `tools/filter-robust.ts` (đa cửa sổ).

## 1. Baseline (12m)
243 lệnh · WR 42.0% · ROI +21.8% · **PF 1.05** · Sharpe 1.27 · Sortino 2.27 · Calmar 1.95 · ExpR 0.17 · DD 11.3% · hold 36h.
→ Về danh nghĩa có lãi nhưng **PF chỉ 1.05 = cực mong manh**.

## 2. Đặc trưng từng lệnh
Mỗi lệnh ghi 17 đặc trưng tại thời điểm vào: ADX, ATR%, volRatio, trendDist, emaSpread, trendSlope, extension, breakoutAtr, volExp, funding (năm hoá + adverse), btcTrend, closeStrength, **nextConfirm** (nến kế đi tiếp bao nhiêu ATR), MFE/MAE (R), holdHours, R-multiple.
- **OI: KHÔNG khả dụng** — Binance chỉ lưu ~30 ngày OI history, không phủ 12m. Bỏ khỏi phân tích (không bịa).
- **Funding: không phải yếu tố** — trung bình ~1%/năm, lệch không đáng kể (chỉ 3 lệnh |adverse|≥30%).

## 3. Phân nhóm nguyên nhân THUA (141 lệnh)
| Nhóm | Số | % thua | Σpnl | avgR | ADX | vol× |
|---|---|---|---|---|---|---|
| **FAKE_BREAKOUT** (đảo ngay, chưa từng lời) | 65 | **46.1%** | −224% | −1.00 | 28 | 2.42 |
| OTHER | 28 | 19.9% | −56% | −0.55 | 33 | 2.45 |
| WEAK_TREND (ADX<22) | 26 | 18.4% | −53% | −0.55 | 20 | 1.72 |
| VOL_TOO_SMALL | 10 | 7.1% | −9% | −0.57 | 29 | 2.99 |
| NO_VOLUME | 6 | 4.3% | −15% | −0.58 | 33 | 0.86 |

**Fake breakout là kẻ giết người số 1** (46% số lệnh thua, −224% Σpnl, avgR −1.00 = chạm stop full). Nhưng nó có **ADX 28 & volume 2.4× — y hệt lệnh thắng**.

## 4. THẮNG vs THUA — phát hiện then chốt
Tại thời điểm VÀO LỆNH, thắng và thua **không phân biệt được** trên MỌI chỉ báo tiêu chuẩn:

| | ADX | volRatio | extension | breakout | closeStrength | **nextConfirm** | MFE(R) |
|---|---|---|---|---|---|---|---|
| THẮNG | 27.1 | 2.48 | 2.14 | 0.59 | 0.79 | **+0.27** | 3.15 |
| THUA | 27.9 | 2.36 | 1.98 | 0.45 | 0.78 | **−0.26** | 0.57 |

→ Chỉ **`nextConfirm` (nến kế có đi tiếp hướng breakout không)** tách bạch thắng/fake (+0.27 vs −0.57). Tất cả bộ lọc chỉ báo tĩnh (ADX, volume, close-strength) **VÔ DỤNG** — đã kiểm chứng: lọc ADX≥25 làm PF **giảm** còn 0.91.

## 5. Thống kê mẫu (kiểm chứng chống trực giác)
- **ADX cao KHÔNG tốt hơn:** ADX≥19 PF 1.05 → ADX≥25 PF 0.91 → ADX≥32 PF 0.86. Breakout ADX-cao thường là **climax/kiệt sức**.
- **Cụm A_StrongTrend (ADX≥28) PF 0.82** (tệ nhất, −23.5%) < **D_Weak/Range PF 1.31** (tốt nhất, +34.7%).
- **SHORT là vấn đề cấu trúc:** LONG PF **1.74** (WR 47%) vs SHORT PF **0.84** (WR 39%). **51/65 fake breakout là SHORT.**

## 6. Root Cause — vì sao fake breakout?
- **Bot vào vì:** giá vượt kênh Donchian tại nến đó, đủ mọi cổng (regime/EMA/ADX/vol). Nhưng breakout 1-nến trên alt (đặc biệt phe SHORT trong nền tăng) thường bị **bull-trap/absorb** rồi bật lại.
- **Điều làm xác suất giảm:** không có nến follow-through — giá vượt kênh rồi đóng cửa quay đầu ngay nến kế.
- **Lẽ ra nên làm:** **chờ xác nhận** (nến kế đi tiếp) thay vì vào ngay nến breakout, nhất là SHORT.
- **Nếu bỏ nhóm này:** PF 1.05 → 3.16 (mức trade-level; nhưng phân loại dùng MFE = *hồi tố*, không tradeable trực tiếp → phải chuyển thành logic follow-through nhân-quả).

## 7. CẢI TIẾN LOGIC (R1) — Xác nhận breakout bằng nến follow-through
**Logic mới (không đụng tham số):** khi có tín hiệu breakout, **không vào ở nến breakout**; chờ 1 nến, chỉ vào nếu nến kế đi tiếp ≥ `confirmAtr`·ATR theo chiều lệnh. Vào tại close nến xác nhận (giá xấu hơn — đã tính đủ trong backtest thật). Cài `confirmBars/confirmAtr/confirmSide` (opt-in) trong `trend.service.ts`.

Kiểm chứng THẬT (12m, đủ metric):
| Biến thể | ROI | PF | WR | ExpR | Sharpe | Sortino | Calmar | DD | tr/th | Nhận? |
|---|---|---|---|---|---|---|---|---|---|---|
| BASELINE | 21.8% | 1.05 | 42% | 0.17 | 1.27 | 2.27 | 1.95 | 11.3% | 20.3 | — |
| confirm both ≥0.2 | 24.6% | 1.43 | 42% | 0.30 | 1.67 | 3.29 | 2.10 | 11.9% | 13.3 | ⚠ |
| **confirm SHORT-only ≥0.2** | **31.5%** | **1.48** | **47.5%** | **0.34** | **1.96** | **3.73** | **2.98** | **10.7%** | 14.9 | ✅ |
| long-only (ref) | 13.9% | 1.74 | 47% | 0.31 | 1.27 | 2.25 | 2.87 | 4.9% | 7.3 | (bỏ short) |

**Chọn: confirm SHORT-only ≥0.2·ATR.** Vì fake breakout dồn ở SHORT → xác nhận SHORT loại lệnh xấu mà **không đánh thuế phe LONG khỏe** (delay LONG làm mất edge → "confirm both" kém hơn). Giữ được long+short (yêu cầu), cải thiện **mọi** metric, DD còn giảm.

## 8. Round 2 — dừng vòng lặp
Áp R1 rồi phân tích lại: SHORT PF 0.84→**1.32**, short-fake 51→18; LONG vẫn 1.74. Loss còn lại (fake cả 2 phe, weak trend) **không tách được bằng bất kỳ đặc trưng entry nào** (thắng/thua vẫn ADX 29 vs 29, vol 2.36 vs 2.38). Confirm LONG đã chứng minh có hại. Cụm xấu còn lại chỉ 6 lệnh (nhiễu). → **Không còn cải tiến logic đáng kể & bền → dừng** (đúng luật "lặp đến khi hết cải thiện").

## 9. Robustness (đa cửa sổ) — không overfit
| | 6m PF | 12m PF | 24m PF | 24m DD |
|---|---|---|---|---|
| Baseline | 1.09 | 1.05 | 1.23 | 14.9% |
| **+confirm SHORT** | **1.54** | **1.48** | **1.53** | **10.4%** |
Cải thiện PF/Exp/Sharpe/DD **nhất quán cả 3 cửa sổ** — đây là edge THẬT, không phải may cửa sổ.

## 10. Kết luận & khuyến nghị
1. **Vì sao bot thua:** 46% lỗ là fake breakout — breakout 1-nến bị bẫy, nặng nhất ở SHORT. Chỉ báo tĩnh không lọc được vì lệnh xấu trông y hệt lệnh tốt lúc vào.
2. **Vì sao bot thắng:** lệnh có **follow-through** (nến kế đi tiếp) → giữ lâu (58h vs 22h), MFE 3.3R. Long thuận nền BTC tăng.
3. **Cải tiến chốt (logic, không tham số):** **xác nhận breakout SHORT bằng nến follow-through ≥0.2·ATR.** PF 1.05→1.48, Sharpe 1.27→1.96, DD 11.3→10.7%, ExpR ×2, vẫn 14.9 lệnh/tháng, giữ long+short. Bền qua 6/12/24m.
4. **Đã chứng minh SAI (chống trực giác):** lọc ADX cao, lọc volume, lọc close-strength, confirm phe LONG — tất cả làm **giảm** PF. Không thêm.
5. **Đã wire:** `confirmBars/confirmAtr/confirmSide` vào engine + zod (API dùng được). OI không dùng (thiếu dữ liệu); funding không phải yếu tố.
