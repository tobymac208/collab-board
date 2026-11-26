import type { AddressInfo } from "node:net";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach } from "vitest";
import WebSocket from "ws";
import {
  parseServerMessage,
  type ClientRequestBody,
  type ServerEvent,
  type ServerMessage,
  type User,
} from "@collab/shared";
import type { DB } from "../db/schema.ts";
import { createAppServer, WS_PATH, type AppServerOptions } from "../server.ts";
import { createTestDb } from "./pglite.ts";

export interface TestServer {
  base: string;
  db: DB;
  close: () => Promise<void>;
}

/**
 * One migrated database per test file (PGlite takes ~1s to boot), wiped
 * before every test. Call at the top level of a test file.
 */
export function useTestDb(): () => DB {
  let db: DB | undefined;
  beforeAll(async () => {
    db = await createTestDb();
  });
  afterAll(async () => {
    await db?.destroy();
  });
  beforeEach(async () => {
    await sql`TRUNCATE users, sessions, boards, board_members, board_columns, cards`.execute(db!);
  });
  return () => db!;
}

export async function startServer(
  db: DB,
  allowedOrigins: string[] = [],
  options: AppServerOptions = {},
): Promise<TestServer> {
  const { http, wss } = createAppServer(
    { port: 0, allowedOrigins, cookieSecure: false },
    db,
    options,
  );
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const { port } = http.address() as AddressInfo;
  return {
    base: `127.0.0.1:${port}`,
    db,
    close: async () => {
      for (const c of wss.clients) c.terminate();
      wss.close();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}

let userCounter = 0;

/** Signs up a fresh user and returns their session cookie. */
export async function signup(
  server: TestServer,
  overrides: Partial<{ email: string; password: string; displayName: string }> = {},
): Promise<{ user: User; cookie: string }> {
  const n = ++userCounter;
  const res = await fetch(`http://${server.base}/auth/signup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: `user${n}@example.com`,
      password: "correct horse battery",
      displayName: `User ${n}`,
      ...overrides,
    }),
  });
  if (res.status !== 201) throw new Error(`signup failed: ${res.status} ${await res.text()}`);
  return { user: ((await res.json()) as { user: User }).user, cookie: cookieFrom(res) };
}

export function cookieFrom(res: Response): string {
  const header = res.headers.get("set-cookie");
  if (!header) throw new Error("no set-cookie header");
  return header.split(";")[0]!;
}

export interface TestClient {
  ws: WebSocket;
  /** The next message, in arrival order. */
  next: () => Promise<ServerMessage>;
  /** Sends a request and resolves with its events once acked; rejects on error. */
  request: (body: ClientRequestBody) => Promise<ServerEvent[]>;
  /**
   * Everything queued for this client right now: pings the server and
   * collects messages until the pong. A socket's messages arrive in send
   * order, so anything broadcast before the ping is included.
   */
  drain: () => Promise<ServerMessage[]>;
  close: () => void;
}

export async function connectClient(
  server: TestServer,
  cookie?: string,
  origin?: string,
): Promise<TestClient> {
  const headers: Record<string, string> = {};
  if (cookie) headers.cookie = cookie;
  const ws = new WebSocket(`ws://${server.base}${WS_PATH}`, {
    headers,
    ...(origin ? { origin } : {}),
  });

  // Messages tagged with an in-flight request's id go to that request();
  // everything else goes to a queue that next() reads.
  const queue: ServerMessage[] = [];
  const waiters: ((m: ServerMessage) => void)[] = [];
  const pending = new Map<
    string,
    {
      events: ServerEvent[];
      resolve: (events: ServerEvent[]) => void;
      reject: (err: Error) => void;
    }
  >();

  ws.on("message", (data) => {
    const parsed = parseServerMessage(data.toString());
    if (!parsed.ok) throw new Error(parsed.error);
    const msg = parsed.value;
    const owner = "requestId" in msg && msg.requestId ? pending.get(msg.requestId) : undefined;
    if (owner && "requestId" in msg && msg.requestId) {
      if (msg.type === "ack") {
        pending.delete(msg.requestId);
        owner.resolve(owner.events);
      } else if (msg.type === "error") {
        pending.delete(msg.requestId);
        owner.reject(Object.assign(new Error(msg.message), { code: msg.code }));
      } else {
        owner.events.push(msg);
      }
      return;
    }
    const waiter = waiters.shift();
    if (waiter) waiter(msg);
    else queue.push(msg);
  });
  const next = () =>
    new Promise<ServerMessage>((resolve) => {
      const queued = queue.shift();
      if (queued) resolve(queued);
      else waiters.push(resolve);
    });

  let counter = 0;
  const request = (body: ClientRequestBody) =>
    new Promise<ServerEvent[]>((resolve, reject) => {
      const requestId = `r${++counter}`;
      pending.set(requestId, { events: [], resolve, reject });
      ws.send(JSON.stringify({ ...body, requestId }));
    });

  let pingCounter = 0;
  const drain = async (): Promise<ServerMessage[]> => {
    const sentAt = -++pingCounter; // negative, so it can't match a real timestamp
    ws.send(JSON.stringify({ type: "ping", sentAt }));
    const seen: ServerMessage[] = [];
    for (;;) {
      const msg = await next();
      if (msg.type === "pong" && msg.sentAt === sentAt) return seen;
      seen.push(msg);
    }
  };

  return { ws, next, request, drain, close: () => ws.close() };
}

/** Connects and consumes the welcome message. */
export async function login(server: TestServer, cookie: string): Promise<TestClient> {
  const client = await connectClient(server, cookie);
  const welcome = await client.next();
  if (welcome.type !== "welcome") throw new Error(`expected welcome, got ${welcome.type}`);
  return client;
}

/** The single event of a given type that a request produced. */
export function only<T extends ServerEvent["type"]>(
  events: ServerEvent[],
  type: T,
): Extract<ServerEvent, { type: T }> {
  const matches = events.filter((e) => e.type === type);
  if (matches.length !== 1)
    throw new Error(`expected one ${type}, got ${events.map((e) => e.type)}`);
  return matches[0] as Extract<ServerEvent, { type: T }>;
}
