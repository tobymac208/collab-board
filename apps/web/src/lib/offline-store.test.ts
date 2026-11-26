// @vitest-environment jsdom
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { LocalOp } from "./board-state.ts";
import { clearUser, countUnsent, loadBoard, saveBoard } from "./offline-store.ts";

const op = (opId: string, confirmedAt?: number): LocalOp => ({
  op: { type: "delete_card", cardId: "c", opId },
  ...(confirmedAt === undefined ? {} : { confirmedAt }),
});

/**
 * Node 26 has its own `localStorage` global, which is unusable unless Node is
 * started with --localstorage-file and which hides jsdom's. Stand in a simple
 * in-memory Storage so these tests exercise the real code paths.
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

beforeAll(() => {
  Object.defineProperty(window, "localStorage", { value: new MemoryStorage(), configurable: true });
});
beforeEach(() => window.localStorage.clear());

describe("offline store", () => {
  it("round-trips a board and its pending changes", () => {
    saveBoard("u1", "b1", { data: null, ops: [op("o1")], rejected: [] });
    expect(loadBoard("u1", "b1")).toEqual({ data: null, ops: [op("o1")], rejected: [] });
    expect(loadBoard("u1", "other")).toBeNull();
  });

  it("keeps users apart", () => {
    saveBoard("u1", "b1", { data: null, ops: [op("o1")], rejected: [] });
    expect(loadBoard("u2", "b1")).toBeNull();
  });

  it("counts unsent changes across boards, ignoring confirmed ones", () => {
    saveBoard("u1", "b1", { data: null, ops: [op("o1"), op("o2", 5)], rejected: [] });
    saveBoard("u1", "b2", { data: null, ops: [op("o3")], rejected: [] });
    saveBoard("u2", "b1", { data: null, ops: [op("o4")], rejected: [] });
    expect(countUnsent("u1")).toBe(2);
  });

  it("forgets one user's data on logout, and only theirs", () => {
    saveBoard("u1", "b1", { data: null, ops: [op("o1")], rejected: [] });
    saveBoard("u2", "b1", { data: null, ops: [op("o2")], rejected: [] });
    clearUser("u1");
    expect(loadBoard("u1", "b1")).toBeNull();
    expect(loadBoard("u2", "b1")).not.toBeNull();
  });

  it("ignores corrupt entries", () => {
    saveBoard("u1", "b1", { data: null, ops: [], rejected: [] });
    const key = window.localStorage.key(0)!;
    window.localStorage.setItem(key, "{not json");
    expect(loadBoard("u1", "b1")).toBeNull();
    expect(countUnsent("u1")).toBe(0);
  });
});
