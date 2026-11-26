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

  it("requires an opId on board changes, but not on reads", () => {
    const boardId = "8d4b0f9e-4a6c-4b1e-9a57-2f3c1d0e5b6a";
    const rename = { type: "rename_board", requestId: "r", boardId, name: "x" };
    expect(parseClientMessage(raw(rename)).ok).toBe(false);
    expect(
      parseClientMessage(raw({ ...rename, opId: "3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f" })).ok,
    ).toBe(true);
    expect(parseClientMessage(raw({ type: "open_board", requestId: "r", boardId })).ok).toBe(true);
    expect(
      parseClientMessage(raw({ type: "open_board", requestId: "r", boardId, sinceRevision: 7 })).ok,
    ).toBe(true);
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

  it("takes neighbours (or null) for moves, not indexes", () => {
    const move = {
      type: "move_card",
      requestId: "r",
      opId: "3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f",
      cardId: "8d4b0f9e-4a6c-4b1e-9a57-2f3c1d0e5b6a",
      toColumnId: "1f2e3d4c-5b6a-4978-8a9b-0c1d2e3f4a5b",
    };
    const other = "2a3b4c5d-6e7f-4809-9a1b-2c3d4e5f6a7b";
    expect(parseClientMessage(raw({ ...move, afterId: other, beforeId: null })).ok).toBe(true);
    expect(parseClientMessage(raw({ ...move, afterId: null, beforeId: null })).ok).toBe(true);
    expect(parseClientMessage(raw({ ...move, afterId: "x", beforeId: null })).ok).toBe(false);
    expect(parseClientMessage(raw({ ...move, toIndex: 0 })).ok).toBe(false);
  });

  it("requires a base version for each edited card field", () => {
    const update = {
      type: "update_card",
      requestId: "r",
      opId: "3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f",
      cardId: "8d4b0f9e-4a6c-4b1e-9a57-2f3c1d0e5b6a",
    };
    expect(parseClientMessage(raw({ ...update, title: { value: "New", baseVersion: 3 } })).ok).toBe(
      true,
    );
    expect(parseClientMessage(raw({ ...update, title: "New" })).ok).toBe(false);
    expect(parseClientMessage(raw({ ...update, title: { value: "New" } })).ok).toBe(false);
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
      version: 0,
    };
    expect(parseServerMessage(raw({ type: "card_upserted", card, revision: 4 })).ok).toBe(true);
  });

  it("requires a revision on board changes", () => {
    const card = {
      id: "c1",
      boardId: "b1",
      columnId: "col1",
      title: "t",
      description: "",
      position: "a0",
      version: 0,
    };
    expect(parseServerMessage(raw({ type: "card_upserted", card })).ok).toBe(false);
    expect(parseServerMessage(raw({ type: "card_upserted", card, revision: -1 })).ok).toBe(false);
  });

  it("accepts presence updates", () => {
    const msg = {
      type: "presence",
      boardId: "8d4b0f9e-4a6c-4b1e-9a57-2f3c1d0e5b6a",
      viewers: [{ userId: "u1", displayName: "Ada", cardIds: [] }],
    };
    expect(parseServerMessage(raw(msg))).toEqual({ ok: true, value: msg });
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
