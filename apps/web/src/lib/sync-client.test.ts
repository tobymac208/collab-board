import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HEARTBEAT_TIMEOUT_MS, RequestError, SyncClient } from "./sync-client.ts";

/** A WebSocket stand-in the test drives by hand. */
class FakeSocket {
  static instances: FakeSocket[] = [];
  static readonly OPEN = 1;
  readyState = FakeSocket.OPEN;
  sent: unknown[] = [];
  closed = false;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;

  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.closed = true;
  }
  /** Delivers a message from the "server". */
  receive(message: unknown) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
  welcome() {
    this.receive({
      type: "welcome",
      protocolVersion: 5,
      connectionId: "c",
      user: { id: "u", email: "u@x.io", displayName: "U" },
    });
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeSocket);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const BOARD = "8d4b0f9e-4a6c-4b1e-9a57-2f3c1d0e5b6a";

function connected() {
  const client = new SyncClient("ws://test/ws", { isSessionValid: async () => true });
  client.start();
  const socket = FakeSocket.instances[0]!;
  socket.welcome();
  return { client, socket };
}

describe("SyncClient heartbeat", () => {
  it("stays connected while the server keeps answering", () => {
    const { client, socket } = connected();
    for (let i = 0; i < 6; i++) {
      vi.advanceTimersByTime(5_000);
      socket.receive({ type: "pong", sentAt: Date.now(), serverTime: Date.now() });
    }
    expect(client.getStatus().status).toBe("open");
    expect(socket.closed).toBe(false);
  });

  it("gives up on a silent connection, fails what was in flight, and reconnects", async () => {
    const { client, socket } = connected();
    const inFlight = client.request({ type: "open_board", boardId: BOARD });

    // The network dies without closing the socket: nothing more arrives.
    // Pings go out every 5s; the one at 15s finds 15s of silence (> 12s).
    vi.advanceTimersByTime(15_000);

    await expect(inFlight).rejects.toMatchObject({ code: "disconnected" });
    await expect(inFlight).rejects.toBeInstanceOf(RequestError);
    expect(socket.closed).toBe(true);
    expect(client.getStatus().status).toBe("closed");

    // And it tries again.
    await vi.runOnlyPendingTimersAsync();
    expect(FakeSocket.instances).toHaveLength(2);
  });

  it("ignores a late close event from the abandoned socket", async () => {
    const { client, socket } = connected();
    vi.advanceTimersByTime(HEARTBEAT_TIMEOUT_MS + 5_000);
    await vi.runOnlyPendingTimersAsync();
    const replacement = FakeSocket.instances[1]!;
    replacement.welcome();
    socket.onclose?.({ code: 1006 }); // handlers were detached, so this is a no-op
    expect(client.getStatus().status).toBe("open");
  });
});
