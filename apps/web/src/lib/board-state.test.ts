import { describe, expect, it } from "vitest";
import type { Card, Column } from "@collab/shared";
import {
  applyEvent,
  findColumnOf,
  layoutOf,
  moveCardInLayout,
  moveColumnInLayout,
  type BoardState,
} from "./board-state.ts";

const BOARD = "b1";
const column = (id: string, position: string): Column => ({
  id,
  boardId: BOARD,
  name: id,
  position,
});
const card = (id: string, columnId: string, position: string): Card => ({
  id,
  boardId: BOARD,
  columnId,
  title: id,
  description: "",
  position,
});

function snapshot(): BoardState {
  return applyEvent(
    null,
    {
      type: "board_snapshot",
      board: { id: BOARD, name: "Board", role: "owner" },
      members: [],
      // Deliberately out of order, and using keys where byte order differs
      // from locale order ("Z" < "a").
      columns: [column("done", "a2"), column("todo", "Zz"), column("doing", "a1")],
      cards: [card("c2", "todo", "a1"), card("c1", "todo", "a0"), card("c3", "doing", "a0")],
    },
    BOARD,
  )!;
}

describe("applyEvent", () => {
  it("ignores events for other boards", () => {
    const state = snapshot();
    const other = { ...card("x", "todo", "a5"), boardId: "other" };
    expect(applyEvent(state, { type: "card_upserted", card: other }, BOARD)).toBe(state);
  });

  it("upserts and deletes cards", () => {
    let state = applyEvent(
      snapshot(),
      { type: "card_upserted", card: card("c4", "done", "a0") },
      BOARD,
    )!;
    expect(state.cards.c4?.columnId).toBe("done");
    state = applyEvent(state, { type: "card_deleted", boardId: BOARD, cardId: "c4" }, BOARD)!;
    expect(state.cards.c4).toBeUndefined();
  });

  it("drops a deleted column's cards", () => {
    const state = applyEvent(
      snapshot(),
      { type: "column_deleted", boardId: BOARD, columnId: "todo" },
      BOARD,
    )!;
    expect(Object.keys(state.columns).sort()).toEqual(["doing", "done"]);
    expect(Object.keys(state.cards)).toEqual(["c3"]);
  });

  it("clears the state when the board is deleted", () => {
    expect(applyEvent(snapshot(), { type: "board_deleted", boardId: BOARD }, BOARD)).toBeNull();
  });
});

describe("layout", () => {
  it("orders columns and cards by position, byte-wise", () => {
    expect(layoutOf(snapshot())).toEqual({
      columnOrder: ["todo", "doing", "done"],
      cardsByColumn: { todo: ["c1", "c2"], doing: ["c3"], done: [] },
    });
  });

  it("moves cards within and across columns", () => {
    const layout = layoutOf(snapshot());
    expect(moveCardInLayout(layout, "c1", "todo", 1).cardsByColumn.todo).toEqual(["c2", "c1"]);
    const moved = moveCardInLayout(layout, "c1", "done", 0);
    expect(moved.cardsByColumn).toEqual({ todo: ["c2"], doing: ["c3"], done: ["c1"] });
    expect(findColumnOf(moved, "c1")).toBe("done");
    // The input is not mutated.
    expect(layout.cardsByColumn.todo).toEqual(["c1", "c2"]);
  });

  it("moves columns", () => {
    const layout = layoutOf(snapshot());
    expect(moveColumnInLayout(layout, "done", 0).columnOrder).toEqual(["done", "todo", "doing"]);
  });
});
