import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PROTOCOL_VERSION } from "@collab/shared";
import { CLOSE_SESSION_ENDED } from "./server.ts";
import {
  connectClient,
  cookieFrom,
  login,
  signup,
  startServer,
  useTestDb,
  type TestServer,
} from "./test/harness.ts";

const getDb = useTestDb();
let server: TestServer;

beforeEach(async () => {
  server = await startServer(getDb());
});

afterEach(async () => {
  await server.close();
});

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`http://${server.base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

const get = (path: string, headers: Record<string, string> = {}) =>
  fetch(`http://${server.base}${path}`, { headers });

describe("http", () => {
  it("responds to /health", async () => {
    const res = await get("/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });
});

describe("auth", () => {
  it("signs up, reports the current user, and logs out", async () => {
    const res = await post("/auth/signup", {
      email: "Ada@Example.com",
      password: "correct horse battery",
      displayName: "Ada",
    });
    expect(res.status).toBe(201);
    const setCookie = res.headers.get("set-cookie")!;
    expect(setCookie).toMatch(/HttpOnly/);
    expect(setCookie).toMatch(/SameSite=Lax/);
    const { user } = (await res.json()) as { user: { email: string } };
    expect(user).toMatchObject({ email: "ada@example.com", displayName: "Ada" });

    const cookie = cookieFrom(res);
    const me = await get("/auth/me", { cookie });
    expect(me.status).toBe(200);
    expect(await me.json()).toEqual({ user });

    const logout = await post("/auth/logout", {}, { cookie });
    expect(logout.status).toBe(204);
    expect(logout.headers.get("set-cookie")).toMatch(/Max-Age=0/);
    expect((await get("/auth/me", { cookie })).status).toBe(401);
  });

  it("does not store the raw session token", async () => {
    const { cookie } = await signup(server);
    const token = cookie.split("=")[1]!;
    const rows = await server.db.selectFrom("sessions").select("id").execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).not.toBe(token);
  });

  it("rejects a duplicate email regardless of case", async () => {
    await signup(server, { email: "dup@example.com" });
    const res = await post("/auth/signup", {
      email: "DUP@example.com",
      password: "another password",
      displayName: "Dup",
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "email_taken" });
  });

  it("validates signup input", async () => {
    const res = await post("/auth/signup", { email: "nope", password: "x", displayName: "" });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "bad_request" });
  });

  it("logs in with the right password only", async () => {
    await signup(server, { email: "kim@example.com", password: "s3cret password" });
    expect(
      (await post("/auth/login", { email: "kim@example.com", password: "wrong" })).status,
    ).toBe(401);
    expect(
      (await post("/auth/login", { email: "nobody@example.com", password: "s3cret password" }))
        .status,
    ).toBe(401);
    const ok = await post("/auth/login", {
      email: " KIM@example.com ",
      password: "s3cret password",
    });
    expect(ok.status).toBe(200);
    expect((await get("/auth/me", { cookie: cookieFrom(ok) })).status).toBe(200);
  });

  it("requires a JSON content type", async () => {
    const res = await fetch(`http://${server.base}/auth/login`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "{}",
    });
    expect(res.status).toBe(415);
  });
});

describe("cors", () => {
  beforeEach(async () => {
    await server.close();
    server = await startServer(getDb(), ["http://localhost:3000"]);
  });

  it("allows credentialed requests from allowed origins", async () => {
    const res = await fetch(`http://${server.base}/auth/me`, {
      method: "OPTIONS",
      headers: { origin: "http://localhost:3000" },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("http://localhost:3000");
    expect(res.headers.get("access-control-allow-credentials")).toBe("true");
  });

  it("refuses requests from other origins", async () => {
    const res = await post(
      "/auth/login",
      { email: "a@b.co", password: "x" },
      { origin: "https://evil.example" },
    );
    expect(res.status).toBe(403);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("websocket", () => {
  it("rejects connections without a valid session", async () => {
    for (const cookie of [undefined, "collab_session=forged"]) {
      const { ws } = await connectClient(server, cookie);
      const status = await new Promise<number | undefined>((resolve) => {
        ws.on("unexpected-response", (_req, res) => resolve(res.statusCode));
        ws.on("error", () => resolve(undefined));
      });
      expect(status).toBe(401);
    }
  });

  it("welcomes an authenticated user and answers pings", async () => {
    const { user, cookie } = await signup(server);
    const { ws, next } = await connectClient(server, cookie);
    expect(await next()).toMatchObject({
      type: "welcome",
      protocolVersion: PROTOCOL_VERSION,
      user,
    });
    ws.send(JSON.stringify({ type: "ping", sentAt: 123 }));
    expect(await next()).toMatchObject({ type: "pong", sentAt: 123 });
    ws.close();
  });

  it("reports malformed messages without dropping the connection", async () => {
    const { cookie } = await signup(server);
    const client = await login(server, cookie);

    client.ws.send("not json");
    expect(await client.next()).toMatchObject({ type: "error", code: "bad_message" });

    client.ws.send(JSON.stringify({ type: "create_board", requestId: "r1", name: "" }));
    expect(await client.next()).toMatchObject({
      type: "error",
      code: "bad_message",
      requestId: "r1",
    });

    client.ws.send(JSON.stringify({ type: "ping", sentAt: 1 }));
    expect(await client.next()).toMatchObject({ type: "pong" });
    client.close();
  });

  it("closes the user's sockets on logout", async () => {
    const { cookie } = await signup(server);
    const client = await login(server, cookie);
    const closed = new Promise<number>((resolve) => client.ws.on("close", resolve));
    await post("/auth/logout", {}, { cookie });
    expect(await closed).toBe(CLOSE_SESSION_ENDED);
  });

  it.each([
    ["deleted without a logout", () => server.db.deleteFrom("sessions").execute()],
    [
      "expired",
      () =>
        server.db
          .updateTable("sessions")
          .set({ expires_at: new Date(0) })
          .execute(),
    ],
  ])("stops serving requests once the session is %s", async (_label, endSession) => {
    const { cookie } = await signup(server);
    const client = await login(server, cookie);
    const closed = new Promise<number>((resolve) => client.ws.on("close", resolve));
    await endSession();

    // Several queued requests: none of them may run.
    for (let i = 0; i < 3; i++) {
      client.ws.send(JSON.stringify({ type: "create_board", requestId: `r${i}`, name: `b${i}` }));
    }
    expect(await closed).toBe(CLOSE_SESSION_ENDED);
    expect(await server.db.selectFrom("boards").select("id").execute()).toHaveLength(0);
  });

  it("answers requests in the order they were sent", async () => {
    const { cookie } = await signup(server);
    const client = await login(server, cookie);
    const names = ["one", "two", "three", "four", "five"];
    names.forEach((name, i) =>
      client.ws.send(JSON.stringify({ type: "create_board", requestId: `r${i}`, name })),
    );
    const seen: string[] = [];
    while (seen.length < names.length) {
      const msg = await client.next();
      if (msg.type === "board_upserted") seen.push(msg.board.name);
    }
    expect(seen).toEqual(names);
    client.close();
  });

  it("rejects connections from origins that are not allowed", async () => {
    await server.close();
    server = await startServer(getDb(), ["http://localhost:3000"]);
    const { cookie } = await signup(server);
    const { ws } = await connectClient(server, cookie, "https://evil.example");
    const status = await new Promise<number | undefined>((resolve) => {
      ws.on("unexpected-response", (_req, res) => resolve(res.statusCode));
      ws.on("error", () => resolve(undefined));
    });
    expect(status).toBe(403);

    const allowed = await connectClient(server, cookie, "http://localhost:3000");
    expect(await allowed.next()).toMatchObject({ type: "welcome" });
    allowed.close();
  });
});
