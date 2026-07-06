import { useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { ArrowLeft } from "lucide-react";
import { api } from "../api/client";
import BacktestResults from "../components/BacktestResults";
import type { BacktestHistoryItem } from "../types";

// Nhãn dễ đọc cho vài key params hay gặp
const PARAM_LABEL: Record<string, string> = {
  fastPeriod: "EMA Fast",
  slowPeriod: "EMA Slow",
  entryStates: "State vào lệnh",
  exitStrategy: "Chiến thuật thoát",
  riskPerTradePct: "Rủi ro/lệnh %",
  takeProfitPct: "TP %",
  stopLossPct: "SL %",
  leverage: "Đòn bẩy",
  tpSlMode: "Kiểu TP/SL",
  marginMode: "Ký quỹ",
  initialCapitalUsdt: "Vốn ban đầu",
  positionSizePct: "Ký quỹ % số dư",
  orderSizeUsdt: "Tiền/lệnh",
  maxConcurrentPositions: "Trần lệnh đồng thời",
  minDropPct: "Giảm tối thiểu %",
  minSidewayCandles: "Sideway (nến)",
  maxSidewayRangePct: "Biên sideway %",
  minRisePct: "3 nến tăng %",
  epsilonMode: "Epsilon mode",
  epsilonValue: "Epsilon value",
  atrPeriod: "ATR period",
  feePct: "Phí %",
  slippagePct: "Trượt giá %",
};

const fmtVal = (v: unknown) => (Array.isArray(v) ? v.join(", ") : String(v));

export default function BacktestHistoryDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [item, setItem] = useState<BacktestHistoryItem | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    api
      .getBacktestHistory(Number(id))
      .then((d) => {
        if (alive) setItem(d);
      })
      .catch(() => {
        if (alive) setError("Không tải được bản ghi");
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [id]);

  const remove = async () => {
    if (!item) return;
    try {
      await api.deleteBacktestHistory(item.id);
      toast.success("Đã xóa lịch sử");
      navigate("/backtest-history");
    } catch {
      toast.error("Xóa thất bại");
    }
  };

  const paramEntries = item ? Object.entries(item.params).filter(([, v]) => v !== null && v !== undefined && v !== "") : [];

  return (
    <div className="space-y-4">
      {/* Header + điều hướng */}
      <div className="flex items-center gap-3 flex-wrap">
        <button className="btn btn-ghost" onClick={() => navigate("/backtest-history")}>
          <ArrowLeft size={16} className="mr-1" /> Quay lại lịch sử
        </button>
        {item && (
          <button className="btn btn-ghost text-down ml-auto" onClick={remove}>
            Xóa bản ghi
          </button>
        )}
      </div>

      {loading ? (
        <div className="card text-sm text-gray-400">Đang tải…</div>
      ) : error || !item ? (
        <div className="card text-sm text-down">{error ?? "Không tìm thấy bản ghi"}</div>
      ) : (
        <>
          <div>
            <h2 className="text-xl font-bold flex items-center gap-2 flex-wrap">
              <span
                className={`px-2 py-0.5 rounded text-sm ${
                  item.strategy === "EMA" ? "bg-accent/20 text-accent" : "bg-up/20 text-up"
                }`}
              >
                {item.strategy === "EMA" ? "EMA Classifier" : "Mô hình LONG"}
              </span>
              Khung {item.interval} · {item.month ? `Tháng ${item.month}/${item.year}` : `Năm ${item.year}`}
            </h2>
            <p className="text-xs text-gray-400 mt-1">
              {new Date(item.fromDate).toLocaleDateString()} → {new Date(item.toDate).toLocaleDateString()} · Cập nhật{" "}
              {new Date(item.updatedAt).toLocaleString()}
            </p>
          </div>

          {/* Thông số đã dùng */}
          <div className="card">
            <div className="text-xs text-accent uppercase font-semibold mb-2">Thông số backtest</div>
            <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-x-4 gap-y-2">
              {paramEntries.map(([k, v]) => (
                <div key={k}>
                  <div className="text-[11px] text-gray-500 uppercase">{PARAM_LABEL[k] ?? k}</div>
                  <div className="text-sm font-medium break-words">{fmtVal(v)}</div>
                </div>
              ))}
            </div>
          </div>

          {/* Kết quả đầy đủ */}
          {item.result ? (
            <BacktestResults result={item.result} emptyHint="Bản ghi này không có lệnh nào." />
          ) : (
            <div className="card text-sm text-gray-500">Bản ghi không có dữ liệu kết quả.</div>
          )}
        </>
      )}
    </div>
  );
}
