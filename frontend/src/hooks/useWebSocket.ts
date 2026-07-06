import { useEffect, useRef } from "react";
import { useStore } from "../store/useStore";
import type { Signal } from "../types";

const WS_URL = import.meta.env.VITE_WS_URL ?? "ws://localhost:4000";

/**
 * Kết nối WebSocket realtime, tự reconnect khi rớt.
 * Cập nhật store theo loại message từ backend.
 */
export function useWebSocket() {
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const setConnected = useStore((s) => s.setConnected);
  const addSignal = useStore((s) => s.addSignal);
  const upsertPosition = useStore((s) => s.upsertPosition);
  const setLastScan = useStore((s) => s.setLastScan);

  useEffect(() => {
    let closedByUs = false;

    const connect = () => {
      const ws = new WebSocket(`${WS_URL}/ws`);
      wsRef.current = ws;

      ws.onopen = () => setConnected(true);
      ws.onclose = () => {
        setConnected(false);
        if (!closedByUs) {
          reconnectRef.current = setTimeout(connect, 3000);
        }
      };
      ws.onerror = () => ws.close();
      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data) as { type: string; data: any };
          switch (msg.type) {
            case "signal":
              addSignal(msg.data as Signal);
              break;
            case "position_update":
            case "position_opened":
              upsertPosition(msg.data);
              break;
            case "scan_complete":
              if (msg.data?.at) setLastScan(msg.data.at);
              break;
          }
        } catch {
          /* ignore */
        }
      };
    };

    connect();
    return () => {
      closedByUs = true;
      if (reconnectRef.current) clearTimeout(reconnectRef.current);
      wsRef.current?.close();
    };
  }, [addSignal, setConnected, setLastScan, upsertPosition]);
}
