import { describe, expect, it } from "vitest";
import { parseClientMessage, parseServerMessage, salvageRequestId } from "./protocol.ts";
import { SignupRequest } from "./auth.ts";
import { comparePositions } from "./model.ts";

const raw = (value: unknown) => JSON.stringify(value);

describe("parseClientMessage", () => {
  it("accepts a valid ping", () => {
    expect(parseClientMessage(raw({ type: "ping", sentAt: 1 }))).toEqual({
      ok: true,
      value: { type: "ping", sentAt: 1 },
    });
  });

  it("rejects invalid JSON", () => {
    expect(parseClientMessage("{not json")).toEqual({ ok: false, error: "invalid JSON" });
  });

  it("rejects ids that are not UUIDs", () => {
    expect(parseClientMessage(raw({ type: "open_board", requestId: "r", boardId: "1" })).ok).toBe(
      false,
    );
  });

  it("rejects unknown message types", () => {
    expect(parseClientMessage(raw({ type: "drop_table" })).ok).toBe(false);
  });

  it("rejects a ping with the wrong field type", () => {
    expect(parseClientMessage(raw({ type: "ping", sentAt: "now" })).ok).toBe(false);
  });

  it("requires a request id on requests", () => {
    expect(parseClientMessage(raw({ type: "list_boards" })).ok).toBe(false);
    expect(parseClientMessage(raw({ type: "list_boards", requestId: "r1" })).ok).toBe(true);
  });

  it("trims names and rejects blank ones", () => {
    const parsed = parseClientMessage(
      raw({ type: "create_board", requestId: "r", name: "  Q4  " }),
    );
    expect(parsed).toEqual({
      ok: true,
      value: { type: "create_board", requestId: "r", name: "Q4" },
    });
    expect(parseClientMessage(raw({ type: "create_board", requestId: "r", name: "   " })).ok).toBe(
      false,
    );
  });

  it("rejects negative or fractional move indexes", () => {
    const move = {
      type: "move_card",
      requestId: "r",
      cardId: "8d4b0f9e-4a6c-4b1e-9a57-2f3c1d0e5b6a",
      toColumnId: "1f2e3d4c-5b6a-4978-8a9b-0c1d2e3f4a5b",
    };
    expect(parseClientMessage(raw({ ...move, toIndex: 0 })).ok).toBe(true);
    expect(parseClientMessage(raw({ ...move, toIndex: -1 })).ok).toBe(false);
    expect(parseClientMessage(raw({ ...move, toIndex: 1.5 })).ok).toBe(false);
  });
});

describe("parseServerMessage", () => {
  it("accepts a welcome message", () => {
    const msg = {
      type: "welcome",
      protocolVersion: 2,
      connectionId: "abc",
      user: { id: "u1", email: "a@b.co", displayName: "A" },
    };
    expect(parseServerMessage(raw(msg))).toEqual({ ok: true, value: msg });
  });

  it("accepts state events", () => {
    const card = {
      id: "c1",
      boardId: "b1",
      columnId: "col1",
      title: "Write tests",
      description: "",
      position: "a0",
    };
    expect(parseServerMessage(raw({ type: "card_upserted", card })).ok).toBe(true);
  });
});

describe("salvageRequestId", () => {
  it("recovers the id from an otherwise invalid request", () => {
    expect(salvageRequestId(raw({ type: "create_board", requestId: "r9" }))).toBe("r9");
  });

  it("returns undefined for junk", () => {
    expect(salvageRequestId("nope")).toBeUndefined();
    expect(salvageRequestId("null")).toBeUndefined();
    expect(salvageRequestId(raw({ requestId: 42 }))).toBeUndefined();
  });
});

describe("SignupRequest", () => {
  it("enforces a minimum password length", () => {
    const base = { email: "a@b.co", displayName: "A" };
    expect(SignupRequest.safeParse({ ...base, password: "short" }).success).toBe(false);
    expect(SignupRequest.safeParse({ ...base, password: "long enough" }).success).toBe(true);
  });
});

describe("comparePositions", () => {
  it("orders byte-wise, so uppercase sorts before lowercase", () => {
    const sorted = ["a0", "Zz", "a1", "A0"].map((position) => ({ position }));
    sorted.sort(comparePositions);
    expect(sorted.map((p) => p.position)).toEqual(["A0", "Zz", "a0", "a1"]);
  });
});
