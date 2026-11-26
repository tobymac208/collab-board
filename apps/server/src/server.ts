import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import type { z } from "zod";
import {
  LoginRequest,
  PROTOCOL_VERSION,
  SignupRequest,
  parseClientMessage,
  salvageRequestId,
  type ApiError,
  type ApiErrorCode,
  type AuthResponse,
  type ServerMessage,
} from "@collab/shared";
import type { ServerConfig } from "./config.ts";
import type { DB } from "./db/schema.ts";
import {
  SESSION_COOKIE,
  clearedSessionCookie,
  createSession,
  deleteSession,
  findSession,
  readCookie,
  sessionCookie,
  type Session,
} from "./auth/sessions.ts";
import { EmailTakenError, authenticate, createUser } from "./auth/users.ts";
import { StoreError } from "./boards/store.ts";
import { handleRequest } from "./ws/handlers.ts";

export const WS_PATH = "/ws";

/** Close code sent when the session behind a socket ends (logout). */
export const CLOSE_SESSION_ENDED = 4001;

const MAX_BODY_BYTES = 16 * 1024;
/** Requests a single socket may have queued before we assume it's misbehaving. */
const MAX_PENDING_REQUESTS = 100;

function send(socket: WebSocket, message: ServerMessage): void {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: ApiErrorCode,
    message: string,
  ) {
    super(message);
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers = {}): void {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

async function readJson<T>(req: IncomingMessage, schema: z.ZodType<T>): Promise<T> {
  if (!req.headers["content-type"]?.startsWith("application/json")) {
    // Requiring JSON also forces a CORS preflight for cross-origin callers.
    throw new HttpError(415, "bad_request", "expected application/json");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, "bad_request", "body too large");
    chunks.push(chunk);
  }
  let json: unknown;
  try {
    json = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "bad_request", "invalid JSON");
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const field = issue?.path.join(".");
    throw new HttpError(400, "bad_request", `${field ? `${field}: ` : ""}${issue?.message}`);
  }
  return parsed.data;
}

/**
 * Creates the HTTP + WebSocket server without starting it, so tests can
 * listen on an ephemeral port and shut it down cleanly.
 */
export function createAppServer(
  config: ServerConfig,
  db: DB,
): { http: Server; wss: WebSocketServer } {
  const isAllowedOrigin = (origin: string | undefined) =>
    config.allowedOrigins.length === 0 || (!!origin && config.allowedOrigins.includes(origin));

  /** Open sockets per session, so logging out also disconnects them. */
  const socketsBySession = new Map<string, Set<WebSocket>>();

  // ---- HTTP API ------------------------------------------------------------

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const { pathname } = new URL(req.url ?? "/", "http://localhost");
    const origin = req.headers.origin;

    if (req.method === "GET" && pathname === "/health") {
      sendJson(res, 200, { status: "ok" });
      return;
    }

    if (!pathname.startsWith("/auth/")) {
      res.writeHead(404).end();
      return;
    }

    // CORS: the web app runs on a different origin and sends cookies.
    // Browsers omit Origin on same-origin GETs, so only reject a present,
    // unknown Origin. This also blocks cross-site form posts (CSRF).
    if (origin !== undefined && !isAllowedOrigin(origin)) {
      throw new HttpError(403, "forbidden", "origin not allowed");
    }
    if (origin !== undefined) {
      res.setHeader("access-control-allow-origin", origin);
      res.setHeader("access-control-allow-credentials", "true");
      res.setHeader("vary", "Origin");
    }
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "access-control-allow-methods": "GET, POST",
        "access-control-allow-headers": "content-type",
        "access-control-max-age": "600",
      });
      res.end();
      return;
    }

    const token = readCookie(req.headers.cookie, SESSION_COOKIE);

    const startSession = async (userId: string) => {
      const { token: newToken } = await createSession(db, userId);
      return { "set-cookie": sessionCookie(newToken, config.cookieSecure) };
    };

    const key = `${req.method} ${pathname}`;
    switch (key) {
      case "POST /auth/signup": {
        const body = await readJson(req, SignupRequest);
        let user;
        try {
          user = await createUser(db, body);
        } catch (err) {
          if (err instanceof EmailTakenError) throw new HttpError(409, "email_taken", err.message);
          throw err;
        }
        sendJson(res, 201, { user } satisfies AuthResponse, await startSession(user.id));
        return;
      }
      case "POST /auth/login": {
        const body = await readJson(req, LoginRequest);
        const user = await authenticate(db, body.email, body.password);
        if (!user) throw new HttpError(401, "invalid_credentials", "wrong email or password");
        sendJson(res, 200, { user } satisfies AuthResponse, await startSession(user.id));
        return;
      }
      case "POST /auth/logout": {
        if (token) {
          const sessionId = await deleteSession(db, token);
          for (const socket of socketsBySession.get(sessionId) ?? []) {
            socket.close(CLOSE_SESSION_ENDED, "logged out");
          }
        }
        res.writeHead(204, { "set-cookie": clearedSessionCookie(config.cookieSecure) }).end();
        return;
      }
      case "GET /auth/me": {
        const session = token ? await findSession(db, token) : null;
        if (!session) throw new HttpError(401, "unauthenticated", "not logged in");
        sendJson(res, 200, { user: session.user } satisfies AuthResponse);
        return;
      }
      default:
        throw new HttpError(404, "not_found", "no such endpoint");
    }
  }

  const http = createServer((req, res) => {
    route(req, res).catch((err: unknown) => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (err instanceof HttpError) {
        sendJson(res, err.status, { error: err.code, message: err.message } satisfies ApiError);
        return;
      }
      console.error("unhandled HTTP error", err);
      sendJson(res, 500, { error: "internal", message: "internal error" } satisfies ApiError);
    });
  });

  // ---- WebSocket -----------------------------------------------------------

  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });

  const reject = (socket: Duplex, status: string) => {
    socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
    socket.destroy();
  };

  async function upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const { pathname } = new URL(req.url ?? "/", "http://localhost");
    if (pathname !== WS_PATH) {
      socket.destroy();
      return;
    }
    // Browsers always send Origin; rejecting unknown origins blocks
    // cross-site WebSocket hijacking from other pages.
    if (!isAllowedOrigin(req.headers.origin)) {
      reject(socket, "403 Forbidden");
      return;
    }
    const token = readCookie(req.headers.cookie, SESSION_COOKIE);
    const session = token ? await findSession(db, token) : null;
    if (!session) {
      reject(socket, "401 Unauthorized");
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req, session));
  }

  http.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    socket.on("error", () => socket.destroy());
    upgrade(req, socket, head).catch((err: unknown) => {
      console.error("WebSocket upgrade failed", err);
      reject(socket, "500 Internal Server Error");
    });
  });

  wss.on("connection", (socket: WebSocket, _req: IncomingMessage, session: Session) => {
    const sessionSockets = socketsBySession.get(session.id) ?? new Set();
    sessionSockets.add(socket);
    socketsBySession.set(session.id, sessionSockets);
    socket.on("close", () => {
      sessionSockets.delete(socket);
      if (sessionSockets.size === 0) socketsBySession.delete(session.id);
    });

    send(socket, {
      type: "welcome",
      protocolVersion: PROTOCOL_VERSION,
      connectionId: randomUUID(),
      user: session.user,
    });

    async function handleMessage(raw: string): Promise<void> {
      const parsed = parseClientMessage(raw);
      if (!parsed.ok) {
        const requestId = salvageRequestId(raw);
        send(socket, {
          type: "error",
          ...(requestId ? { requestId } : {}),
          code: "bad_message",
          message: parsed.error,
        });
        return;
      }
      const msg = parsed.value;
      if (msg.type === "ping") {
        send(socket, { type: "pong", sentAt: msg.sentAt, serverTime: Date.now() });
        return;
      }
      try {
        const events = await handleRequest(db, session.user, msg);
        for (const event of events) send(socket, { ...event, requestId: msg.requestId });
        send(socket, { type: "ack", requestId: msg.requestId });
      } catch (err) {
        if (err instanceof StoreError) {
          send(socket, {
            type: "error",
            requestId: msg.requestId,
            code: err.code,
            message: err.message,
          });
          return;
        }
        console.error(`request ${msg.type} failed`, err);
        send(socket, {
          type: "error",
          requestId: msg.requestId,
          code: "internal",
          message: "internal error",
        });
      }
    }

    // Handle one message at a time, so replies arrive in request order and a
    // client's own writes never race each other.
    let queue = Promise.resolve();
    let pending = 0;
    socket.on("message", (data, isBinary) => {
      if (isBinary) {
        send(socket, {
          type: "error",
          code: "unsupported",
          message: "binary frames not supported",
        });
        return;
      }
      if (++pending > MAX_PENDING_REQUESTS) {
        socket.close(1008, "too many pending requests");
        return;
      }
      const raw = data.toString();
      queue = queue
        .then(() => handleMessage(raw))
        .finally(() => {
          pending--;
        });
    });
  });

  return { http, wss };
}
