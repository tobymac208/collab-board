import {
  comparePositions,
  type BoardChangeEvent,
  type BoardMember,
  type BoardSummary,
  type Card,
  type Column,
  type ServerEvent,
  type Viewer,
} from "@collab/shared";

/** Everything the client knows about one open board. */
export interface BoardState {
  board: BoardSummary;
  /** The revision this state reflects. */
  revision: number;
  members: BoardMember[];
  columns: Record<string, Column>;
  cards: Record<string, Card>;
}

/**
 * Client-side sync state for one open board.
 *
 * Board changes carry revisions and must be applied in order, but can arrive
 * out of order (a later change's broadcast may overtake an earlier one) or
 * before the snapshot. Early events wait in `pending` until the gap fills.
 * If it doesn't, the caller reloads the snapshot (see `hasGap`).
 */
export interface BoardSync {
  data: BoardState | null;
  /** Changes that arrived early, sorted by revision. */
  pending: BoardChangeEvent[];
  /** Who has the board open right now. */
  viewers: Viewer[];
  /** The board was deleted while open. */
  deleted: boolean;
}

export const initialSync: BoardSync = { data: null, pending: [], viewers: [], deleted: false };

const byId = <T extends { id: string }>(items: T[]): Record<string, T> =>
  Object.fromEntries(items.map((item) => [item.id, item]));

function without<T>(record: Record<string, T>, key: string): Record<string, T> {
  const copy = { ...record };
  delete copy[key];
  return copy;
}

const isBoardChange = (event: ServerEvent): event is BoardChangeEvent => "revision" in event;

/** The board an event is about, if any. */
export function boardIdOf(event: ServerEvent): string | undefined {
  switch (event.type) {
    case "board_upserted":
    case "board_snapshot":
      return event.board.id;
    case "column_upserted":
      return event.column.boardId;
    case "card_upserted":
      return event.card.boardId;
    case "board_deleted":
    case "member_added":
    case "column_deleted":
    case "card_deleted":
    case "presence":
      return event.boardId;
    case "board_list":
      return undefined;
  }
}

/** Applies one in-order change. The caller has checked board and revision. */
export function applyChange(state: BoardState, event: BoardChangeEvent): BoardState {
  const next = { ...state, revision: event.revision };
  switch (event.type) {
    case "board_upserted":
      // Only the name is shared; our own role doesn't change.
      return { ...next, board: { ...state.board, name: event.board.name } };
    case "board_snapshot":
      return fromSnapshot(event);
    case "member_added":
      return {
        ...next,
        members: [...state.members.filter((m) => m.userId !== event.member.userId), event.member],
      };
    case "column_upserted":
      return { ...next, columns: { ...state.columns, [event.column.id]: event.column } };
    case "column_deleted": {
      const cards = Object.fromEntries(
        Object.entries(state.cards).filter(([, card]) => card.columnId !== event.columnId),
      );
      return { ...next, columns: without(state.columns, event.columnId), cards };
    }
    case "card_upserted":
      return { ...next, cards: { ...state.cards, [event.card.id]: event.card } };
    case "card_deleted":
      return { ...next, cards: without(state.cards, event.cardId) };
  }
}

function fromSnapshot(event: Extract<ServerEvent, { type: "board_snapshot" }>): BoardState {
  return {
    board: event.board,
    revision: event.revision,
    members: event.members,
    columns: byId(event.columns),
    cards: byId(event.cards),
  };
}

/** Applies every pending change that is now next in line; drops stale ones. */
function drain(data: BoardState, pending: BoardChangeEvent[]) {
  let state = data;
  const rest: BoardChangeEvent[] = [];
  for (const event of pending) {
    if (event.revision <= state.revision) continue; // already reflected
    if (event.revision === state.revision + 1) state = applyChange(state, event);
    else rest.push(event);
  }
  return { data: state, pending: rest };
}

function insertByRevision(pending: BoardChangeEvent[], event: BoardChangeEvent) {
  if (pending.some((e) => e.revision === event.revision)) return pending;
  return [...pending, event].sort((a, b) => a.revision - b.revision);
}

/** Folds one server event into the sync state of the board `boardId`. */
export function syncReducer(sync: BoardSync, event: ServerEvent, boardId: string): BoardSync {
  if (boardIdOf(event) !== boardId) return sync;

  if (event.type === "presence") return { ...sync, viewers: event.viewers };
  if (event.type === "board_deleted") return { ...initialSync, deleted: true };
  if (!isBoardChange(event)) return sync;

  if (event.type === "board_snapshot") {
    return { ...sync, ...drain(fromSnapshot(event), sync.pending), deleted: false };
  }
  // Nothing to apply changes to yet: keep them for when the snapshot lands.
  if (!sync.data) return { ...sync, pending: insertByRevision(sync.pending, event) };
  if (event.revision <= sync.data.revision) return sync; // duplicate or already in snapshot
  if (event.revision > sync.data.revision + 1) {
    return { ...sync, pending: insertByRevision(sync.pending, event) };
  }
  return { ...sync, ...drain(applyChange(sync.data, event), sync.pending) };
}

/** Whether changes are stuck waiting for a revision that hasn't arrived. */
export const hasGap = (sync: BoardSync) => sync.data !== null && sync.pending.length > 0;

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
