import { useEffect, useRef, useState } from "react";
import {
  createChart,
  ColorType,
  IChartApi,
  CandlestickData,
  LineData,
  HistogramData,
  Time,
  SeriesMarker,
  CrosshairMode,
} from "lightweight-charts";
import { api } from "../api/client";
import type { Signal, Position } from "../types";

interface Props {
  symbol: string;
  signal?: Signal | null;
  position?: Position | null;
  /** Khung thời gian mặc định khi mở chart */
  defaultInterval?: string;
  /** true = lấy nến từ dữ liệu 1m LOCAL (parquet) thay vì Binance realtime */
  local?: boolean;
  /** Số nến tải về (mặc định 400) */
  limit?: number;
  /** Chỉ dùng khi local: lọc theo khoảng thời gian (ms) */
  from?: number;
  to?: number;
  /** Ẩn bộ chọn khung (khi trang cha tự quản khung) */
  hideIntervalSwitch?: boolean;
}

const INTERVALS = ["1m", "15m", "1h", "4h", "1d"] as const;

function ema(values: number[], period: number): (number | null)[] {
  const k = 2 / (period + 1);
  const out: (number | null)[] = [];
  let prev: number | null = null;
  values.forEach((v, i) => {
    if (i < period - 1) {
      out.push(null);
    } else if (prev === null) {
      const seed = values.slice(i - period + 1, i + 1).reduce((a, b) => a + b, 0) / period;
      prev = seed;
      out.push(seed);
    } else {
      prev = v * k + prev * (1 - k);
      out.push(prev);
    }
  });
  return out;
}

/**
 * Chart nến + EMA20/50/200 + Volume + RSI (pane riêng), đánh dấu
 * điểm tín hiệu / điểm vào lệnh / TP / SL bằng price lines & markers.
 */
export default function Chart({
  symbol,
  signal,
  position,
  defaultInterval = "15m",
  local = false,
  limit = 400,
  from,
  to,
  hideIntervalSwitch = false,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const [interval, setInterval] = useState<string>(defaultInterval);

  useEffect(() => {
    if (!containerRef.current) return;

    const chart = createChart(containerRef.current, {
      layout: {
        background: { type: ColorType.Solid, color: "#161a1e" },
        textColor: "#cbd5e1",
      },
      grid: {
        vertLines: { color: "#2b3139" },
        horzLines: { color: "#2b3139" },
      },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: "#2b3139" },
      timeScale: { borderColor: "#2b3139", timeVisible: true },
      autoSize: true,
    });
    chartRef.current = chart;

    const candleSeries = chart.addCandlestickSeries({
      upColor: "#0ecb81",
      downColor: "#f6465d",
      borderVisible: false,
      wickUpColor: "#0ecb81",
      wickDownColor: "#f6465d",
    });

    const ema20Series = chart.addLineSeries({ color: "#f0b90b", lineWidth: 1, title: "EMA20" });
    const ema50Series = chart.addLineSeries({ color: "#3b82f6", lineWidth: 1, title: "EMA50" });
    const ema200Series = chart.addLineSeries({ color: "#a855f7", lineWidth: 1, title: "EMA200" });

    const volumeSeries = chart.addHistogramSeries({
      priceFormat: { type: "volume" },
      priceScaleId: "vol",
    });
    chart.priceScale("vol").applyOptions({
      scaleMargins: { top: 0.8, bottom: 0 },
    });

    let cancelled = false;

    const loader = local
      ? api.getLocalKlines(symbol, interval, limit, from, to)
      : api.getKlines(symbol, interval, limit);

    loader
      .then(({ klines }) => {
        if (cancelled || klines.length === 0) return;

        const candles: CandlestickData[] = klines.map((k) => ({
          time: (k.openTime / 1000) as Time,
          open: k.open,
          high: k.high,
          low: k.low,
          close: k.close,
        }));
        candleSeries.setData(candles);

        const closes = klines.map((k) => k.close);
        const toLine = (arr: (number | null)[]): LineData[] =>
          arr
            .map((v, i) =>
              v === null ? null : { time: (klines[i].openTime / 1000) as Time, value: v }
            )
            .filter((x): x is LineData => x !== null);

        ema20Series.setData(toLine(ema(closes, 20)));
        ema50Series.setData(toLine(ema(closes, 50)));
        ema200Series.setData(toLine(ema(closes, 200)));

        const vol: HistogramData[] = klines.map((k) => ({
          time: (k.openTime / 1000) as Time,
          value: k.volume,
          color: k.close >= k.open ? "rgba(14,203,129,0.5)" : "rgba(246,70,93,0.5)",
        }));
        volumeSeries.setData(vol);

        // ---- Price lines: Entry / TP / SL ----
        const entry = position?.entryPrice ?? signal?.entryPrice;
        const tp = position?.takeProfit ?? signal?.takeProfit;
        const sl = position?.stopLoss ?? signal?.stopLoss;

        if (entry)
          candleSeries.createPriceLine({
            price: entry,
            color: "#f0b90b",
            lineWidth: 1,
            lineStyle: 2,
            axisLabelVisible: true,
            title: "ENTRY",
          });
        if (tp)
          candleSeries.createPriceLine({
            price: tp,
            color: "#0ecb81",
            lineWidth: 1,
            lineStyle: 2,
            axisLabelVisible: true,
            title: "TP +",
          });
        if (sl)
          candleSeries.createPriceLine({
            price: sl,
            color: "#f6465d",
            lineWidth: 1,
            lineStyle: 2,
            axisLabelVisible: true,
            title: "SL -",
          });

        // ---- Markers: điểm phát hiện tín hiệu & vào lệnh ----
        const markers: SeriesMarker<Time>[] = [];
        const lastTime = (klines[klines.length - 1].openTime / 1000) as Time;
        if (signal)
          markers.push({
            time: lastTime,
            position: "belowBar",
            color: "#f0b90b",
            shape: "arrowUp",
            text: `Signal ${signal.probability}%`,
          });
        if (position)
          markers.push({
            time: lastTime,
            position: "belowBar",
            color: "#0ecb81",
            shape: "arrowUp",
            text: "ENTRY",
          });
        if (markers.length) candleSeries.setMarkers(markers);

        chart.timeScale().fitContent();
      })
      .catch(() => {
        /* lỗi tải chart - bỏ qua, UI vẫn hiển thị khung trống */
      });

    return () => {
      cancelled = true;
      chart.remove();
    };
  }, [symbol, signal, position, interval, local, limit, from, to]);

  return (
    <div className="card p-2">
      <div className="flex items-center justify-between px-2 py-1">
        <span className="font-semibold">{symbol}</span>
        <div className="flex items-center gap-2">
          {!hideIntervalSwitch && (
          <div className="flex overflow-hidden rounded border border-[#2b3139]">
            {INTERVALS.map((tf) => (
              <button
                key={tf}
                onClick={() => setInterval(tf)}
                className={`px-2 py-0.5 text-xs transition-colors ${
                  interval === tf
                    ? "bg-[#f0b90b] text-black font-semibold"
                    : "text-gray-300 hover:bg-[#2b3139]"
                }`}
              >
                {tf}
              </button>
            ))}
          </div>
          )}
          <span className="text-xs text-gray-400">{interval} · EMA 20/50/200 · Volume</span>
        </div>
      </div>
      <div ref={containerRef} className="w-full h-[420px]" />
    </div>
  );
}
