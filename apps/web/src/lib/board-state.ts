import {
  comparePositions,
  positionAtEnd,
  positionBetweenNeighbours,
  type BoardChangeEvent,
  type BoardMember,
  type BoardSummary,
  type Card,
  type ClientRequestBody,
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
  /** This client's own changes the server hasn't confirmed yet (see `viewOf`). */
  ops: LocalOp[];
  /** Changes made offline that the server refused once we reconnected. */
  rejected: RejectedOp[];
}

export const initialSync: BoardSync = {
  data: null,
  pending: [],
  viewers: [],
  deleted: false,
  ops: [],
  rejected: [],
};

// ---- optimistic updates --------------------------------------------------
//
// `data` holds only what the server has confirmed. Our own changes are kept
// as a list of operations and replayed on top of it to produce what we show
// (`viewOf`). Because they're replayed rather than baked in, changes from
// other people slot in underneath ours and nothing has to be untangled when
// the server answers:
//
// - on success, the op is dropped once `data` reaches the revision of the
//   server's reply, which by then contains the same change;
// - on failure, the op is dropped straight away, which rolls it back.

/** Requests that change board state and can be predicted locally. */
export type BoardOp = Extract<
  ClientRequestBody,
  {
    type:
      | "rename_board"
      | "create_column"
      | "rename_column"
      | "move_column"
      | "delete_column"
      | "create_card"
      | "move_card"
      | "delete_card";
  }
>;

export interface LocalOp {
  op: BoardOp;
  /** Set when the server accepted it: the revision its reply produced. */
  confirmedAt?: number;
  /**
   * Made while offline, or interrupted by a disconnect. If the server later
   * refuses it, it goes to the review list instead of a passing error toast,
   * since the user may have long moved on.
   */
  deferred?: boolean;
}

/** An offline change the server refused, kept so the user can review it. */
export interface RejectedOp {
  op: BoardOp;
  code: string;
  message: string;
}

export type BoardAction =
  | { kind: "event"; event: ServerEvent }
  | { kind: "op_started"; op: BoardOp; deferred: boolean }
  | { kind: "op_confirmed"; opId: string; revision: number }
  /** Refused while the user was there to see it: roll back. */
  | { kind: "op_failed"; opId: string }
  /** Lost its connection before the server answered: will be resent. */
  | { kind: "op_deferred"; opId: string }
  /** A deferred change was refused: roll back and keep it for review. */
  | { kind: "op_rejected"; opId: string; error: Omit<RejectedOp, "op"> }
  | { kind: "rejected_dismissed"; opId: string }
  /** State saved in the browser, loaded when the board opens. */
  | { kind: "restored"; data: BoardState | null; ops: LocalOp[]; rejected: RejectedOp[] };

const sortedCards = (state: BoardState, columnId: string, except?: string) =>
  Object.values(state.cards)
    .filter((c) => c.columnId === columnId && c.id !== except)
    .sort(comparePositions);

const sortedColumns = (state: BoardState, except?: string) =>
  Object.values(state.columns)
    .filter((c) => c.id !== except)
    .sort(comparePositions);

/**
 * Predicts the effect of one of our own requests. Uses the same placement
 * rules as the server, so the prediction usually matches exactly. If the
 * thing it refers to is gone, it does nothing; the server will reject it.
 */
export function applyLocal(state: BoardState, op: BoardOp): BoardState {
  switch (op.type) {
    case "rename_board":
      return { ...state, board: { ...state.board, name: op.name } };

    case "create_column": {
      if (!op.id) return state;
      const column: Column = {
        id: op.id,
        boardId: state.board.id,
        name: op.name,
        position: positionAtEnd(sortedColumns(state)),
      };
      return { ...state, columns: { ...state.columns, [column.id]: column } };
    }
    case "rename_column": {
      const column = state.columns[op.columnId];
      if (!column) return state;
      return { ...state, columns: { ...state.columns, [column.id]: { ...column, name: op.name } } };
    }
    case "move_column": {
      const column = state.columns[op.columnId];
      if (!column) return state;
      const position = positionBetweenNeighbours(
        sortedColumns(state, column.id),
        op.afterId,
        op.beforeId,
      );
      return { ...state, columns: { ...state.columns, [column.id]: { ...column, position } } };
    }
    case "delete_column": {
      if (!state.columns[op.columnId]) return state;
      const cards = Object.fromEntries(
        Object.entries(state.cards).filter(([, card]) => card.columnId !== op.columnId),
      );
      return { ...state, columns: without(state.columns, op.columnId), cards };
    }

    case "create_card": {
      if (!op.id || !state.columns[op.columnId]) return state;
      const card: Card = {
        id: op.id,
        boardId: state.board.id,
        columnId: op.columnId,
        title: op.title,
        description: "",
        position: positionAtEnd(sortedCards(state, op.columnId)),
        version: 0,
      };
      return { ...state, cards: { ...state.cards, [card.id]: card } };
    }
    case "move_card": {
      const card = state.cards[op.cardId];
      if (!card || !state.columns[op.toColumnId]) return state;
      const position = positionBetweenNeighbours(
        sortedCards(state, op.toColumnId, card.id),
        op.afterId,
        op.beforeId,
      );
      return {
        ...state,
        cards: { ...state.cards, [card.id]: { ...card, columnId: op.toColumnId, position } },
      };
    }
    case "delete_card":
      return state.cards[op.cardId] ? { ...state, cards: without(state.cards, op.cardId) } : state;
  }
}

/** What to show: confirmed state with our unconfirmed changes on top. */
export function viewOf(sync: BoardSync): BoardState | null {
  if (!sync.data) return null;
  return sync.ops.reduce((state, { op }) => applyLocal(state, op), sync.data);
}

/** Drops confirmed ops whose effect the confirmed state now includes. */
function pruneOps(sync: BoardSync): BoardSync {
  const revision = sync.data?.revision ?? -1;
  const ops = sync.ops.filter((o) => o.confirmedAt === undefined || o.confirmedAt > revision);
  return ops.length === sync.ops.length ? sync : { ...sync, ops };
}

/** The board reducer: server events plus the lifecycle of our own changes. */
export function boardReducer(sync: BoardSync, action: BoardAction, boardId: string): BoardSync {
  const withoutOp = (opId: string) => sync.ops.filter((o) => o.op.opId !== opId);
  switch (action.kind) {
    case "event":
      return pruneOps(syncReducer(sync, action.event, boardId));
    case "op_started":
      return {
        ...sync,
        ops: [...sync.ops, { op: action.op, ...(action.deferred ? { deferred: true } : {}) }],
      };
    case "op_confirmed":
      return pruneOps({
        ...sync,
        ops: sync.ops.map((o) =>
          o.op.opId === action.opId ? { ...o, confirmedAt: action.revision } : o,
        ),
      });
    case "op_failed":
      return { ...sync, ops: withoutOp(action.opId) };
    case "op_deferred":
      return {
        ...sync,
        ops: sync.ops.map((o) => (o.op.opId === action.opId ? { ...o, deferred: true } : o)),
      };
    case "op_rejected": {
      const local = sync.ops.find((o) => o.op.opId === action.opId);
      if (!local) return sync;
      return {
        ...sync,
        ops: withoutOp(action.opId),
        rejected: [...sync.rejected, { op: local.op, ...action.error }],
      };
    }
    case "rejected_dismissed":
      return { ...sync, rejected: sync.rejected.filter((r) => r.op.opId !== action.opId) };
    case "restored": {
      // Saved state is older than anything we've received since, so it only
      // fills gaps: keep newer board data, and put saved changes first (they
      // were made earlier) without duplicating any we already have.
      const data =
        sync.data && (!action.data || sync.data.revision >= action.data.revision)
          ? sync.data
          : action.data;
      const known = new Set(sync.ops.map((o) => o.op.opId));
      const knownRejected = new Set(sync.rejected.map((r) => r.op.opId));
      return pruneOps({
        ...sync,
        data,
        ops: [
          ...action.ops.filter((o) => !known.has(o.op.opId)).map((o) => ({ ...o, deferred: true })),
          ...sync.ops,
        ],
        rejected: [
          ...action.rejected.filter((r) => !knownRejected.has(r.op.opId)),
          ...sync.rejected,
        ],
      });
    }
  }
}

/** Our changes the server hasn't accepted yet (still to send, or in flight). */
export const unsentOps = (sync: BoardSync) => sync.ops.filter((o) => o.confirmedAt === undefined);

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
