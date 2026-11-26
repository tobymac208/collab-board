import { describe, expect, it } from "vitest";
import type { BoardChangeEvent, Card, Column, ServerEvent } from "@collab/shared";
import {
  findColumnOf,
  hasGap,
  initialSync,
  layoutOf,
  moveCardInLayout,
  moveColumnInLayout,
  syncReducer,
  type BoardSync,
} from "./board-state.ts";

const BOARD = "b1";
const column = (id: string, position: string): Column => ({
  id,
  boardId: BOARD,
  name: id,
  position,
});
const card = (id: string, columnId: string, position: string, title = id): Card => ({
  id,
  boardId: BOARD,
  columnId,
  title,
  description: "",
  position,
});

const snapshotEvent = (revision = 10): ServerEvent => ({
  type: "board_snapshot",
  board: { id: BOARD, name: "Board", role: "owner" },
  revision,
  members: [],
  // Deliberately out of order, and using keys where byte order differs
  // from locale order ("Z" < "a").
  columns: [column("done", "a2"), column("todo", "Zz"), column("doing", "a1")],
  cards: [card("c2", "todo", "a1"), card("c1", "todo", "a0"), card("c3", "doing", "a0")],
});

const upsert = (revision: number, c: Card): BoardChangeEvent => ({
  type: "card_upserted",
  card: c,
  revision,
});

const run = (events: ServerEvent[], from: BoardSync = initialSync) =>
  events.reduce((sync, event) => syncReducer(sync, event, BOARD), from);

const loaded = () => run([snapshotEvent()]);
const titles = (sync: BoardSync) =>
  Object.values(sync.data?.cards ?? {})
    .map((c) => c.title)
    .sort();

describe("syncReducer: applying changes", () => {
  it("loads a snapshot", () => {
    const sync = loaded();
    expect(sync.data?.revision).toBe(10);
    expect(Object.keys(sync.data!.cards).sort()).toEqual(["c1", "c2", "c3"]);
  });

  it("applies the next revision and advances", () => {
    const sync = run([upsert(11, card("c4", "done", "a0"))], loaded());
    expect(sync.data?.revision).toBe(11);
    expect(sync.data?.cards.c4?.columnId).toBe("done");
  });

  it("ignores events for other boards", () => {
    const sync = loaded();
    const other = upsert(11, { ...card("x", "todo", "a5"), boardId: "other" });
    expect(syncReducer(sync, other, BOARD)).toBe(sync);
  });

  it("ignores duplicates and changes the snapshot already includes", () => {
    const sync = loaded();
    expect(syncReducer(sync, upsert(10, card("c1", "todo", "a0", "stale")), BOARD)).toBe(sync);
    expect(syncReducer(sync, upsert(3, card("c1", "todo", "a0", "older")), BOARD)).toBe(sync);
  });

  it("drops a deleted column's cards", () => {
    const sync = run(
      [{ type: "column_deleted", boardId: BOARD, columnId: "todo", revision: 11 }],
      loaded(),
    );
    expect(Object.keys(sync.data!.columns).sort()).toEqual(["doing", "done"]);
    expect(Object.keys(sync.data!.cards)).toEqual(["c3"]);
  });

  it("keeps its own role when someone renames the board", () => {
    const sync = run(
      [
        {
          type: "board_upserted",
          board: { id: BOARD, name: "Renamed", role: "editor" },
          revision: 11,
        },
      ],
      loaded(),
    );
    expect(sync.data?.board).toEqual({ id: BOARD, name: "Renamed", role: "owner" });
  });

  it("marks the board deleted", () => {
    const sync = run([{ type: "board_deleted", boardId: BOARD }], loaded());
    expect(sync).toMatchObject({ data: null, deleted: true });
  });

  it("tracks presence, even before the snapshot", () => {
    const viewers = [{ userId: "u1", displayName: "Ada" }];
    expect(run([{ type: "presence", boardId: BOARD, viewers }]).viewers).toEqual(viewers);
  });
});

describe("syncReducer: ordering", () => {
  it("holds back early changes until the gap fills, then applies them in order", () => {
    // Revision 12 renames c1; 11 (arriving late) also renames it. 12 must win.
    let sync = run([upsert(12, card("c1", "todo", "a0", "twelve"))], loaded());
    expect(sync.data?.revision).toBe(10);
    expect(hasGap(sync)).toBe(true);

    sync = run([upsert(11, card("c1", "todo", "a0", "eleven"))], sync);
    expect(sync.data?.revision).toBe(12);
    expect(sync.data?.cards.c1?.title).toBe("twelve");
    expect(hasGap(sync)).toBe(false);
  });

  it("applies a long run of shuffled changes as if they arrived in order", () => {
    const changes = [11, 12, 13, 14, 15].map((r) => upsert(r, card(`n${r}`, "done", `a${r}`)));
    const shuffled = [changes[3]!, changes[0]!, changes[4]!, changes[2]!, changes[1]!];
    const sync = run(shuffled, loaded());
    expect(sync.data?.revision).toBe(15);
    expect(sync.pending).toEqual([]);
    expect(titles(sync)).toEqual(["c1", "c2", "c3", "n11", "n12", "n13", "n14", "n15"]);
  });

  it("keeps changes that arrive before the snapshot, and drops the ones it includes", () => {
    const sync = run([
      upsert(10, card("c1", "todo", "a0", "already in snapshot")),
      upsert(11, card("c9", "done", "a0", "after snapshot")),
      snapshotEvent(10),
    ]);
    expect(sync.data?.revision).toBe(11);
    expect(sync.data?.cards.c1?.title).toBe("c1");
    expect(sync.data?.cards.c9?.title).toBe("after snapshot");
    expect(sync.pending).toEqual([]);
  });

  it("recovers from a gap that never fills when a fresh snapshot arrives", () => {
    let sync = run([upsert(13, card("c7", "done", "a0"))], loaded());
    expect(hasGap(sync)).toBe(true);
    // Reload: the server is now at 13, and the snapshot includes c7.
    const fresh = snapshotEvent(13) as Extract<ServerEvent, { type: "board_snapshot" }>;
    sync = run([{ ...fresh, cards: [...fresh.cards, card("c7", "done", "a0")] }], sync);
    expect(sync.data?.revision).toBe(13);
    expect(hasGap(sync)).toBe(false);
  });
});

describe("layout", () => {
  it("orders columns and cards by position, byte-wise", () => {
    expect(layoutOf(loaded().data!)).toEqual({
      columnOrder: ["todo", "doing", "done"],
      cardsByColumn: { todo: ["c1", "c2"], doing: ["c3"], done: [] },
    });
  });

  it("moves cards within and across columns", () => {
    const layout = layoutOf(loaded().data!);
    expect(moveCardInLayout(layout, "c1", "todo", 1).cardsByColumn.todo).toEqual(["c2", "c1"]);
    const moved = moveCardInLayout(layout, "c1", "done", 0);
    expect(moved.cardsByColumn).toEqual({ todo: ["c2"], doing: ["c3"], done: ["c1"] });
    expect(findColumnOf(moved, "c1")).toBe("done");
    // The input is not mutated.
    expect(layout.cardsByColumn.todo).toEqual(["c1", "c2"]);
  });

  it("moves columns", () => {
    const layout = layoutOf(loaded().data!);
    expect(moveColumnInLayout(layout, "done", 0).columnOrder).toEqual(["done", "todo", "doing"]);
  });
});
