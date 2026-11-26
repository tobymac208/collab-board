import { describe, expect, it } from "vitest";
import { parseClientMessage, parseServerMessage } from "./protocol.ts";

describe("parseClientMessage", () => {
  it("accepts a valid ping", () => {
    expect(parseClientMessage(JSON.stringify({ type: "ping", sentAt: 1 }))).toEqual({
      ok: true,
      value: { type: "ping", sentAt: 1 },
    });
  });

  it("rejects invalid JSON", () => {
    expect(parseClientMessage("{not json")).toEqual({ ok: false, error: "invalid JSON" });
  });

  it("rejects unknown message types", () => {
    expect(parseClientMessage(JSON.stringify({ type: "drop_table" })).ok).toBe(false);
  });

  it("rejects a ping with the wrong field type", () => {
    expect(parseClientMessage(JSON.stringify({ type: "ping", sentAt: "now" })).ok).toBe(false);
  });
});

describe("parseServerMessage", () => {
  it("accepts a welcome message", () => {
    const msg = { type: "welcome", protocolVersion: 1, connectionId: "abc" };
    expect(parseServerMessage(JSON.stringify(msg))).toEqual({ ok: true, value: msg });
  });
});
