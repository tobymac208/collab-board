import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { parseServerMessage, type ServerMessage } from "@collab/shared";
import { createAppServer, WS_PATH } from "./server.ts";

let cleanup: (() => Promise<void>) | undefined;

afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

async function start(allowedOrigins: string[] = []) {
  const { http, wss } = createAppServer({ port: 0, allowedOrigins });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  cleanup = async () => {
    for (const c of wss.clients) c.terminate();
    wss.close();
    await new Promise<void>((resolve) => http.close(() => resolve()));
  };
  const { port } = http.address() as AddressInfo;
  return { base: `127.0.0.1:${port}` };
}

/** Collects parsed server messages so tests can await the next one. */
function connect(url: string, origin?: string) {
  const ws = new WebSocket(url, origin ? { origin } : undefined);
  const queue: ServerMessage[] = [];
  const waiters: ((m: ServerMessage) => void)[] = [];
  ws.on("message", (data) => {
    const parsed = parseServerMessage(data.toString());
    if (!parsed.ok) throw new Error(parsed.error);
    const waiter = waiters.shift();
    if (waiter) waiter(parsed.value);
    else queue.push(parsed.value);
  });
  const next = () =>
    new Promise<ServerMessage>((resolve) => {
      const queued = queue.shift();
      if (queued) resolve(queued);
      else waiters.push(resolve);
    });
  return { ws, next };
}

describe("app server", () => {
  it("responds to /health", async () => {
    const { base } = await start();
    const res = await fetch(`http://${base}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("sends a welcome message and answers pings", async () => {
    const { base } = await start();
    const { ws, next } = connect(`ws://${base}${WS_PATH}`);

    const welcome = await next();
    expect(welcome).toMatchObject({ type: "welcome", protocolVersion: 1 });

    ws.send(JSON.stringify({ type: "ping", sentAt: 123 }));
    expect(await next()).toMatchObject({ type: "pong", sentAt: 123 });
    ws.close();
  });

  it("reports malformed messages without dropping the connection", async () => {
    const { base } = await start();
    const { ws, next } = connect(`ws://${base}${WS_PATH}`);
    await next(); // welcome

    ws.send("not json");
    expect(await next()).toMatchObject({ type: "error", code: "bad_message" });

    ws.send(JSON.stringify({ type: "ping", sentAt: 1 }));
    expect(await next()).toMatchObject({ type: "pong" });
    ws.close();
  });

  it("rejects connections from origins that are not allowed", async () => {
    const { base } = await start(["http://localhost:3000"]);
    const { ws } = connect(`ws://${base}${WS_PATH}`, "https://evil.example");
    const status = await new Promise<number | undefined>((resolve) => {
      ws.on("unexpected-response", (_req, res) => resolve(res.statusCode));
      ws.on("error", () => resolve(undefined));
    });
    expect(status).toBe(403);
  });

  it("accepts connections from allowed origins", async () => {
    const { base } = await start(["http://localhost:3000"]);
    const { ws, next } = connect(`ws://${base}${WS_PATH}`, "http://localhost:3000");
    expect(await next()).toMatchObject({ type: "welcome" });
    ws.close();
  });
});
