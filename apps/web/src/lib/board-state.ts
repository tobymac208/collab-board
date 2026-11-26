import {
  comparePositions,
  type BoardMember,
  type BoardSummary,
  type Card,
  type Column,
  type ServerEvent,
} from "@collab/shared";

/** Everything the client knows about one open board. */
export interface BoardState {
  board: BoardSummary;
  members: BoardMember[];
  columns: Record<string, Column>;
  cards: Record<string, Card>;
}

const byId = <T extends { id: string }>(items: T[]): Record<string, T> =>
  Object.fromEntries(items.map((item) => [item.id, item]));

function without<T>(record: Record<string, T>, key: string): Record<string, T> {
  const copy = { ...record };
  delete copy[key];
  return copy;
}

/**
 * Applies a server event to the open board. Events for other boards are
 * ignored, which matters once the server starts broadcasting (phase 2).
 */
export function applyEvent(
  state: BoardState | null,
  event: ServerEvent,
  boardId: string,
): BoardState | null {
  if (event.type === "board_snapshot") {
    if (event.board.id !== boardId) return state;
    return {
      board: event.board,
      members: event.members,
      columns: byId(event.columns),
      cards: byId(event.cards),
    };
  }
  if (!state) return state;

  switch (event.type) {
    case "board_upserted":
      return event.board.id === boardId ? { ...state, board: event.board } : state;
    case "board_deleted":
      return event.boardId === boardId ? null : state;
    case "member_added":
      if (event.boardId !== boardId) return state;
      return {
        ...state,
        members: [...state.members.filter((m) => m.userId !== event.member.userId), event.member],
      };
    case "column_upserted":
      if (event.column.boardId !== boardId) return state;
      return { ...state, columns: { ...state.columns, [event.column.id]: event.column } };
    case "column_deleted": {
      if (event.boardId !== boardId) return state;
      const cards = Object.fromEntries(
        Object.entries(state.cards).filter(([, card]) => card.columnId !== event.columnId),
      );
      return { ...state, columns: without(state.columns, event.columnId), cards };
    }
    case "card_upserted":
      if (event.card.boardId !== boardId) return state;
      return { ...state, cards: { ...state.cards, [event.card.id]: event.card } };
    case "card_deleted":
      if (event.boardId !== boardId) return state;
      return { ...state, cards: without(state.cards, event.cardId) };
    case "board_list":
      return state;
  }
}

/** Board layout as ordered ids: the shape drag and drop works with. */
export interface Layout {
  columnOrder: string[];
  cardsByColumn: Record<string, string[]>;
}

export function layoutOf(state: BoardState): Layout {
  const columns = Object.values(state.columns).sort(comparePositions);
  const cardsByColumn: Record<string, string[]> = Object.fromEntries(
    columns.map((c) => [c.id, [] as string[]]),
  );
  for (const card of Object.values(state.cards).sort(comparePositions)) {
    cardsByColumn[card.columnId]?.push(card.id);
  }
  return { columnOrder: columns.map((c) => c.id), cardsByColumn };
}

/** Moves a card to `index` in `toColumn` (index counted after removal). */
export function moveCardInLayout(
  layout: Layout,
  cardId: string,
  toColumn: string,
  index: number,
): Layout {
  const cardsByColumn = Object.fromEntries(
    Object.entries(layout.cardsByColumn).map(([col, ids]) => [
      col,
      ids.filter((id) => id !== cardId),
    ]),
  );
  const target = cardsByColumn[toColumn];
  if (!target) return layout;
  target.splice(Math.min(index, target.length), 0, cardId);
  return { ...layout, cardsByColumn };
}

export function moveColumnInLayout(layout: Layout, columnId: string, index: number): Layout {
  const columnOrder = layout.columnOrder.filter((id) => id !== columnId);
  columnOrder.splice(Math.min(index, columnOrder.length), 0, columnId);
  return { ...layout, columnOrder };
}

export function findColumnOf(layout: Layout, cardId: string): string | undefined {
  return Object.keys(layout.cardsByColumn).find((col) =>
    layout.cardsByColumn[col]!.includes(cardId),
  );
}
