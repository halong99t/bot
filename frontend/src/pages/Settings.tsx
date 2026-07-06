import { useEffect, useState } from "react";
import { toast } from "sonner";
import { api } from "../api/client";
import type { Settings as SettingsType } from "../types";

export default function Settings() {
  const [form, setForm] = useState<Partial<SettingsType>>({});
  const [saved, setSaved] = useState(false);
  const [loading, setLoading] = useState(true);
  const [regime, setRegime] = useState<{ side: string; close: number | null; ema: number | null } | null>(null);

  useEffect(() => {
    api
      .getSettings()
      .then((s) => setForm(s))
      .finally(() => setLoading(false));
    api.getRegime().then(setRegime).catch(() => {});
  }, []);

  const update = (k: keyof SettingsType, v: unknown) => {
    setForm((f) => ({ ...f, [k]: v }));
    setSaved(false);
  };

  const save = async () => {
    const payload: Partial<SettingsType> = {
      takeProfitPct: Number(form.takeProfitPct),
      stopLossPct: Number(form.stopLossPct),
      orderSizeUsdt: Number(form.orderSizeUsdt),
      leverage: Number(form.leverage),
      marginMode: form.marginMode,
      tpSlMode: form.tpSlMode,
      scanIntervalMs: Number(form.scanIntervalMs),
      autoTrade: Boolean(form.autoTrade),
      strategyMode: "TREND",
      regimeMode: form.regimeMode,
      paperTrade: Boolean(form.paperTrade),
      riskPerTradePct: Number(form.riskPerTradePct),
    };
    // chỉ gửi key/secret nếu người dùng nhập mới (không chứa dấu *)
    if (form.binanceApiKey && !form.binanceApiKey.includes("*"))
      payload.binanceApiKey = form.binanceApiKey;
    if (form.binanceApiSecret && !form.binanceApiSecret.includes("*"))
      payload.binanceApiSecret = form.binanceApiSecret;

    try {
      await api.updateSettings(payload);
      setSaved(true);
      toast.success("Đã lưu cài đặt");
    } catch (e: any) {
      toast.error(e?.response?.data?.message ?? "Lưu cài đặt thất bại");
    }
  };

  if (loading) return <div className="text-gray-400">Đang tải...</div>;

  const Field = ({
    label,
    children,
  }: {
    label: string;
    children: React.ReactNode;
  }) => (
    <div className="space-y-1">
      <label className="text-xs text-gray-400 uppercase">{label}</label>
      {children}
    </div>
  );

  const regimeColor = regime?.side === "LONG" ? "text-up" : regime?.side === "SHORT" ? "text-down" : "text-gray-400";

  return (
    <div className="space-y-4 max-w-2xl">
      <h2 className="text-xl font-bold">Settings</h2>

      {/* Chiến lược tự đánh */}
      <div className="card space-y-4">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <h3 className="font-semibold text-accent">🤖 Chiến lược tự đánh</h3>
          {regime && (
            <span className="text-xs text-gray-400">
              Regime BTC: <b className={regimeColor}>{regime.side}</b>
              {regime.close ? <span className="text-gray-500"> (close {regime.close.toFixed(0)} vs EMA200 {regime.ema?.toFixed(0)})</span> : null}
            </span>
          )}
        </div>
        <div className="grid grid-cols-2 gap-4">
          <Field label="Cặp khung (regime → alt)">
            <select
              className="input"
              value={form.regimeMode ?? "BTC1H_ALT1H"}
              onChange={(e) => update("regimeMode", e.target.value)}
            >
              <option value="BTC1H_ALT1H">BTC 1h → alt 1h</option>
            </select>
          </Field>
          <Field label="Chế độ đặt lệnh">
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => update("paperTrade", true)}
                className={`btn ${form.paperTrade ? "btn-primary" : "btn-ghost"}`}
              >
                📝 Paper (mô phỏng)
              </button>
              <button
                type="button"
                onClick={() => update("paperTrade", false)}
                className={`btn ${!form.paperTrade ? "btn-primary" : "btn-ghost"}`}
              >
                💵 Live (lệnh thật)
              </button>
            </div>
          </Field>
          <Field label="Rủi ro / lệnh (%) — TREND">
            <input
              type="number"
              step="0.1"
              className="input"
              value={form.riskPerTradePct ?? ""}
              onChange={(e) => update("riskPerTradePct", e.target.value)}
            />
          </Field>
          <Field label="Auto Trade">
            <label className="flex items-center gap-2 mt-2 text-sm">
              <input
                type="checkbox"
                checked={Boolean(form.autoTrade)}
                onChange={(e) => update("autoTrade", e.target.checked)}
              />
              Tự vào/cắt lệnh khi có tín hiệu
            </label>
          </Field>
        </div>
        <p className="text-[11px] text-gray-500">
          <b>TREND</b>: mỗi chu kỳ scan tự tính regime BTC (local /1m), phát hiện breakout Donchian+EMA+ADX theo đúng
          chiều regime, tự mở lệnh, tự trailing (Chandelier) và tự cắt (stop/regime lật). <b>Paper</b> = không đặt lệnh
          sàn, chỉ ghi mô phỏng vào Positions/Trades. Chạy mô phỏng nhanh trên lịch sử: dùng trang <b>Trend Following</b>.
        </p>
      </div>

      <div className="card space-y-4">
        <h3 className="font-semibold text-accent">Risk Management</h3>
        <div className="grid grid-cols-2 gap-4">
          <Field label="Take Profit %">
            <input
              type="number"
              className="input"
              value={form.takeProfitPct ?? ""}
              onChange={(e) => update("takeProfitPct", e.target.value)}
            />
          </Field>
          <Field label="Stop Loss %">
            <input
              type="number"
              className="input"
              value={form.stopLossPct ?? ""}
              onChange={(e) => update("stopLossPct", e.target.value)}
            />
          </Field>
          <Field label="Khối lượng / lệnh (USDT)">
            <input
              type="number"
              className="input"
              value={form.orderSizeUsdt ?? ""}
              onChange={(e) => update("orderSizeUsdt", e.target.value)}
            />
          </Field>
          <Field label="Đòn bẩy (x)">
            <input
              type="number"
              className="input"
              value={form.leverage ?? ""}
              onChange={(e) => update("leverage", e.target.value)}
            />
          </Field>
          <Field label="Chế độ ký quỹ">
            <div className="flex gap-2">
              {(["CROSS", "ISOLATED"] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => update("marginMode", m)}
                  className={`btn ${form.marginMode === m ? "btn-primary" : "btn-ghost"}`}
                >
                  {m === "CROSS" ? "Cross" : "Isolated"}
                </button>
              ))}
            </div>
          </Field>
          <Field label="Cách tính TP/SL">
            <div className="flex gap-2">
              {(["MARGIN", "PRICE"] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => {
                    update("tpSlMode", m);
                    update("takeProfitPct", m === "MARGIN" ? 90 : 30);
                    update("stopLossPct", m === "MARGIN" ? 50 : 10);
                    update("leverage", m === "MARGIN" ? 5 : 20);
                  }}
                  className={`btn ${form.tpSlMode === m ? "btn-primary" : "btn-ghost"}`}
                >
                  {m === "MARGIN" ? "Theo margin" : "Theo giá"}
                </button>
              ))}
            </div>
          </Field>
          <Field label="Scan interval (ms)">
            <input
              type="number"
              className="input"
              value={form.scanIntervalMs ?? ""}
              onChange={(e) => update("scanIntervalMs", e.target.value)}
            />
          </Field>
        </div>
      </div>

      <div className="card space-y-4">
        <h3 className="font-semibold text-accent">Binance API</h3>
        <p className="text-xs text-gray-400">
          {form.hasCredentials
            ? "✓ Đã cấu hình. Để trống nếu không muốn thay đổi."
            : "⚠ Chưa cấu hình. Bot chỉ scan, không thể vào lệnh khi thiếu key."}
        </p>
        <Field label="API Key">
          <input
            className="input"
            placeholder="Nhập Binance API Key"
            value={form.binanceApiKey ?? ""}
            onChange={(e) => update("binanceApiKey", e.target.value)}
          />
        </Field>
        <Field label="API Secret">
          <input
            type="password"
            className="input"
            placeholder="Nhập Binance API Secret"
            value={form.binanceApiSecret ?? ""}
            onChange={(e) => update("binanceApiSecret", e.target.value)}
          />
        </Field>
      </div>

      <div className="flex items-center gap-3">
        <button className="btn btn-primary" onClick={save}>
          Lưu cấu hình
        </button>
        {saved && <span className="text-up text-sm">✓ Đã lưu</span>}
      </div>
    </div>
  );
}
