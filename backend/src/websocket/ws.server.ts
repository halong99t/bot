import { WebSocketServer, WebSocket } from "ws";
import { Server } from "http";
import { logger } from "../lib/logger";

/**
 * WebSocket server đẩy dữ liệu realtime tới frontend:
 *  - scan_complete, signal, position_opened, position_update, position_closed, price.
 */

let wss: WebSocketServer | null = null;

export interface WsMessage {
  type:
    | "scan_complete"
    | "signal"
    | "position_opened"
    | "position_update"
    | "position_closed"
    | "price"
    | "ping";
  data: unknown;
}

export function initWebSocket(server: Server) {
  wss = new WebSocketServer({ server, path: "/ws" });

  wss.on("connection", (socket: WebSocket) => {
    logger.info("ws", "Client kết nối WebSocket");
    socket.send(JSON.stringify({ type: "ping", data: { ts: Date.now() } }));

    socket.on("close", () => logger.info("ws", "Client ngắt kết nối"));
    socket.on("error", (e) => logger.warn("ws", `WS error: ${String(e)}`));
  });

  // Heartbeat
  setInterval(() => {
    broadcast({ type: "ping", data: { ts: Date.now() } });
  }, 30000);

  logger.info("ws", "WebSocket server sẵn sàng tại /ws");
}

export function broadcast(message: WsMessage) {
  if (!wss) return;
  const payload = JSON.stringify(message);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  }
}
