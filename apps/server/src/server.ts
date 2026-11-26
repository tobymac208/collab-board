import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { PROTOCOL_VERSION, parseClientMessage, type ServerMessage } from "@collab/shared";
import type { ServerConfig } from "./config.ts";

export const WS_PATH = "/ws";

function send(socket: WebSocket, message: ServerMessage): void {
  socket.send(JSON.stringify(message));
}

/**
 * Creates the HTTP + WebSocket server without starting it, so tests can
 * listen on an ephemeral port and shut it down cleanly.
 */
export function createAppServer(config: ServerConfig): { http: Server; wss: WebSocketServer } {
  const http = createServer((req, res) => {
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }
    res.writeHead(404).end();
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });

  http.on("upgrade", (req, socket, head) => {
    const { pathname } = new URL(req.url ?? "/", "http://localhost");
    if (pathname !== WS_PATH) {
      socket.destroy();
      return;
    }
    // Browsers always send Origin; rejecting unknown origins blocks
    // cross-site WebSocket hijacking from other pages.
    const origin = req.headers.origin;
    if (config.allowedOrigins.length > 0 && (!origin || !config.allowedOrigins.includes(origin))) {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });

  wss.on("connection", (socket) => {
    send(socket, {
      type: "welcome",
      protocolVersion: PROTOCOL_VERSION,
      connectionId: randomUUID(),
    });

    socket.on("message", (data, isBinary) => {
      if (isBinary) {
        send(socket, {
          type: "error",
          code: "unsupported",
          message: "binary frames not supported",
        });
        return;
      }
      const parsed = parseClientMessage(data.toString());
      if (!parsed.ok) {
        send(socket, { type: "error", code: "bad_message", message: parsed.error });
        return;
      }
      const msg = parsed.value;
      switch (msg.type) {
        case "ping":
          send(socket, { type: "pong", sentAt: msg.sentAt, serverTime: Date.now() });
          break;
      }
    });
  });

  return { http, wss };
}
