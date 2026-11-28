// @vitest-environment jsdom
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { LocalOp } from "./board-state.ts";
import {
  clearUser,
  countUnsent,
  forgetBoard,
  resetTabForTests,
  restoreBoard,
  saveBoard,
} from "./offline-store.ts";

/**
 * Node 26 has its own `localStorage`/`sessionStorage` globals, unusable
 * without --localstorage-file, which hide jsdom's. Stand in simple in-memory
 * versions so these tests exercise the real code paths.
 */
class MemoryStorage implements Storage {
  #items = new Map<string, string>();
  get length() {
    return this.#items.size;
  }
  clear() {
    this.#items.clear();
  }
  getItem(key: string) {
    return this.#items.get(key) ?? null;
  }
  key(index: number) {
    return [...this.#items.keys()][index] ?? null;
  }
  removeItem(key: string) {
    this.#items.delete(key);
  }
  setItem(key: string, value: string) {
    this.#items.set(key, String(value));
  }
}

/** Just enough of the Web Locks API: exclusive locks, `ifAvailable`, release. */
class FakeLocks {
  held = new Set<string>();
  async request(
    name: string,
    _options: { ifAvailable?: boolean },
    callback: (lock: { name: string } | null) => unknown,
  ) {
    if (this.held.has(name)) return callback(null);
    this.held.add(name);
    const result = callback({ name });
    // A callback that never settles holds the lock for good (a tab's own lock).
    void Promise.resolve(result).then(() => this.held.delete(name));
    return result;
  }
  /** Simulates the tab holding `name` being closed. */
  release(name: string) {
    this.held.delete(name);
  }
}

let locks: FakeLocks;
let tab: MemoryStorage; // sessionStorage, which belongs to one tab

/** Switches the test to acting as a different (or the same, reloaded) tab. */
function becomeTab(session: MemoryStorage) {
  tab = session;
  Object.defineProperty(window, "sessionStorage", { value: session, configurable: true });
  resetTabForTests();
}

beforeAll(() => {
  Object.defineProperty(window, "localStorage", { value: new MemoryStorage(), configurable: true });
});

beforeEach(() => {
  window.localStorage.clear();
  locks = new FakeLocks();
  Object.defineProperty(navigator, "locks", { value: locks, configurable: true });
  becomeTab(new MemoryStorage());
});

const op = (opId: string, confirmedAt?: number): LocalOp => ({
  op: { type: "delete_card", cardId: "c", opId },
  ...(confirmedAt === undefined ? {} : { confirmedAt }),
});
const empty = { data: null, rejected: [] };
const opIds = (saved: { ops: LocalOp[] } | null) => saved?.ops.map((o) => o.op.opId).sort();
const tabLockOf = (session: MemoryStorage) =>
  `collab-board:tab:${session.getItem("collab-board:tab-id")}`;

describe("offline store", () => {
  it("round-trips a board and its pending changes", async () => {
    expect(await saveBoard("u1", "b1", { ...empty, ops: [op("o1")] })).toBe(true);
    expect(await restoreBoard("u1", "b1")).toEqual({ ...empty, ops: [op("o1")] });
    expect(await restoreBoard("u1", "other")).toBeNull();
  });

  it("survives a reload of the same tab", async () => {
    await saveBoard("u1", "b1", { ...empty, ops: [op("o1")] });
    locks.release(tabLockOf(tab)); // the old page is gone
    becomeTab(tab); // same sessionStorage: same tab, reloaded
    expect(opIds(await restoreBoard("u1", "b1"))).toEqual(["o1"]);
  });

  it("keeps users apart", async () => {
    await saveBoard("u1", "b1", { ...empty, ops: [op("o1")] });
    expect(await restoreBoard("u2", "b1")).toBeNull();
  });

  it("doesn't let two open tabs overwrite each other's queue", async () => {
    await saveBoard("u1", "b1", { ...empty, ops: [op("from-a")] });
    becomeTab(new MemoryStorage()); // tab B, while A is still open
    await saveBoard("u1", "b1", { ...empty, ops: [op("from-b")] });
    // B doesn't take A's queue while A is open...
    expect(opIds(await restoreBoard("u1", "b1"))).toEqual(["from-b"]);
    // ...and both are kept.
    expect(countUnsent("u1")).toBe(2);
  });

  it("adopts the queue of a tab that was closed, once", async () => {
    await saveBoard("u1", "b1", { ...empty, ops: [op("from-a")] });
    const tabA = tab;
    becomeTab(new MemoryStorage());
    await saveBoard("u1", "b1", { ...empty, ops: [op("from-b")] });
    locks.release(tabLockOf(tabA)); // tab A closes

    expect(opIds(await restoreBoard("u1", "b1"))).toEqual(["from-a", "from-b"]);
    // A's entry is gone now that B has it, so nobody adopts it twice.
    becomeTab(new MemoryStorage());
    expect(await restoreBoard("u1", "b1")).toBeNull();
  });

  it("gives a duplicated tab its own identity", async () => {
    await saveBoard("u1", "b1", { ...empty, ops: [op("original")] });
    const copy = new MemoryStorage();
    copy.setItem("collab-board:tab-id", tab.getItem("collab-board:tab-id")!);
    becomeTab(copy); // "Duplicate tab" copies sessionStorage
    await saveBoard("u1", "b1", { ...empty, ops: [op("duplicate")] });
    expect(countUnsent("u1")).toBe(2); // two separate entries, nothing overwritten
  });

  it("counts unsent changes across boards once each, ignoring confirmed ones", async () => {
    await saveBoard("u1", "b1", { ...empty, ops: [op("o1"), op("o2", 5)] });
    await saveBoard("u1", "b2", { ...empty, ops: [op("o3")] });
    await saveBoard("u2", "b1", { ...empty, ops: [op("o4")] });
    expect(countUnsent("u1")).toBe(2);
  });

  it("forgets a board in every tab, and one user's data on logout", async () => {
    await saveBoard("u1", "b1", { ...empty, ops: [op("o1")] });
    await saveBoard("u1", "b2", { ...empty, ops: [op("o2")] });
    await saveBoard("u2", "b1", { ...empty, ops: [op("o3")] });
    forgetBoard("u1", "b1");
    expect(await restoreBoard("u1", "b1")).toBeNull();
    clearUser("u1");
    expect(await restoreBoard("u1", "b2")).toBeNull();
    expect(await restoreBoard("u2", "b1")).not.toBeNull();
  });

  it("ignores corrupt entries", async () => {
    await saveBoard("u1", "b1", { ...empty, ops: [] });
    window.localStorage.setItem(window.localStorage.key(0)!, "{not json");
    expect(await restoreBoard("u1", "b1")).toBeNull();
    expect(countUnsent("u1")).toBe(0);
  });

  it("reports when it couldn't save", async () => {
    const full = new MemoryStorage();
    full.setItem = () => {
      throw new DOMException("quota", "QuotaExceededError");
    };
    const original = window.localStorage;
    Object.defineProperty(window, "localStorage", { value: full, configurable: true });
    try {
      expect(await saveBoard("u1", "b1", { ...empty, ops: [op("o1")] })).toBe(false);
    } finally {
      Object.defineProperty(window, "localStorage", { value: original, configurable: true });
    }
  });
});
