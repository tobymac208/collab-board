import { describe, expect, it } from "vitest";
import {
  applyUpdate,
  createUndo,
  cursorAt,
  cursorIndex,
  isEmptyUpdate,
  diffSince,
  editText,
  encodeState,
  encodeStateVector,
  fromBase64,
  loadCardDoc,
  mergeUpdates,
  newCardDoc,
  onDocUpdate,
  readText,
  seedUpdate,
  toBase64,
  type CardDoc,
} from "./crdt.ts";

const seeded = (title: string, description = "") => {
  const doc = newCardDoc();
  applyUpdate(doc, seedUpdate(title, description));
  return doc;
};

/** Exchanges whatever each side is missing, the way a reconnect does. */
function sync(a: CardDoc, b: CardDoc) {
  const toB = diffSince(a, encodeStateVector(b));
  const toA = diffSince(b, encodeStateVector(a));
  applyUpdate(b, toB);
  applyUpdate(a, toA);
}

describe("card text CRDT", () => {
  it("seeds deterministically, so two seeds of the same text don't duplicate it", () => {
    expect(seedUpdate("Plan", "notes")).toEqual(seedUpdate("Plan", "notes"));
    const doc = seeded("Plan", "notes");
    applyUpdate(doc, seedUpdate("Plan", "notes")); // e.g. server seed + offline browser seed
    expect(readText(doc, "title")).toBe("Plan");
    expect(readText(doc, "description")).toBe("notes");
  });

  it("merges concurrent edits to the same text, keeping both", () => {
    const alice = seeded("Plan");
    const bob = loadCardDoc(encodeState(alice));
    editText(alice, "title", 4, 0, " A");
    editText(bob, "title", 0, 0, "B ");
    sync(alice, bob);
    expect(readText(alice, "title")).toBe(readText(bob, "title"));
    expect(readText(alice, "title")).toBe("B Plan A");
  });

  it("converges whatever order updates arrive in, and ignores repeats", () => {
    const origin = seeded("abc");
    const peers = [0, 1, 2].map(() => loadCardDoc(encodeState(origin)));
    const updates: Uint8Array[] = [];
    peers.forEach((doc, i) => {
      onDocUpdate(doc, (u) => updates.push(u));
      editText(doc, "description", 0, 0, `peer${i} `);
    });
    editText(peers[0]!, "title", 1, 1, ""); // a deletion too
    const forward = loadCardDoc(encodeState(origin));
    const backward = loadCardDoc(encodeState(origin));
    for (const u of updates) applyUpdate(forward, u);
    for (const u of [...updates].reverse()) applyUpdate(backward, u);
    expect(applyUpdate(forward, updates[0]!)).toBe(false); // already had it
    expect(readText(forward, "description")).toBe(readText(backward, "description"));
    expect(readText(forward, "title")).toBe("ac");
  });

  it("reports whether an update changed anything", () => {
    const doc = seeded("x");
    const other = loadCardDoc(encodeState(doc));
    let update: Uint8Array | undefined;
    onDocUpdate(other, (u) => (update = u));
    editText(other, "title", 1, 0, "y");
    expect(applyUpdate(doc, update!)).toBe(true);
    expect(applyUpdate(doc, update!)).toBe(false);
  });

  it("merges a batch of updates into one", () => {
    const doc = seeded("");
    const batch: Uint8Array[] = [];
    onDocUpdate(doc, (u) => batch.push(u));
    for (const ch of "hello") editText(doc, "title", readText(doc, "title").length, 0, ch);
    const target = seeded("");
    applyUpdate(target, mergeUpdates(batch));
    expect(readText(target, "title")).toBe("hello");
  });

  it("round-trips bytes through base64", () => {
    const bytes = encodeState(seeded("Ünïcödé ✓", "x".repeat(70_000)));
    expect(fromBase64(toBase64(bytes))).toEqual(bytes);
  });

  it("keeps a cursor next to the same character as others edit before it", () => {
    const doc = seeded("hello world");
    const cursor = cursorAt(doc, "title", 6); // before "world"
    const other = loadCardDoc(encodeState(doc));
    editText(other, "title", 0, 0, ">> ");
    applyUpdate(doc, diffSince(other, encodeStateVector(doc)));
    expect(cursorIndex(doc, "title", cursor)).toBe(9);
    expect(cursorIndex(doc, "description", cursor)).toBeNull(); // another field
    expect(cursorIndex(doc, "title", { nonsense: true })).toBeNull();
  });

  it("undoes only this user's own changes", () => {
    const doc = seeded("base");
    const mine = Symbol("me");
    const undo = createUndo(doc, "title", mine);
    editText(doc, "title", 4, 0, " mine", mine);
    editText(doc, "title", 0, 0, "theirs ", "remote");
    undo.undo();
    expect(readText(doc, "title")).toBe("theirs base");
    undo.redo();
    expect(readText(doc, "title")).toBe("theirs base mine");
    undo.destroy();
  });

  it("recognises an empty diff", () => {
    const a = seeded("same");
    const b = loadCardDoc(encodeState(a));
    expect(isEmptyUpdate(diffSince(a, encodeStateVector(b)))).toBe(true);
    editText(a, "title", 0, 0, "x");
    expect(isEmptyUpdate(diffSince(a, encodeStateVector(b)))).toBe(false);
  });
});
