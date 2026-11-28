import { z } from "zod";
import { BoardMember, BoardSummary, Card, Column, User, Viewer, fields } from "./model.ts";

/**
 * Wire protocol between the browser and the WebSocket server.
 *
 * Every message is a JSON object with a `type` discriminator. Both sides parse
 * incoming messages with these schemas, so a malformed message is rejected at
 * the edge instead of propagating as `any`.
 *
 * Requests carry a client-chosen `requestId`. The server answers a request
 * with zero or more state events (`board_snapshot`, `card_upserted`, ...)
 * followed by exactly one `ack` or `error`, all carrying the same `requestId`.
 * Clients apply state events as they arrive; the ack signals completion.
 *
 * Real time: a socket that opens a board (`open_board`) receives everyone
 * else's changes to it as the same state events, without a `requestId`,
 * until it sends `close_board`, opens another board, or disconnects.
 * Board-list changes (`board_upserted`, `board_deleted`) go to every member.
 *
 * Ordering: every change to a board increments its `revision`, and each
 * board event carries the revision it produced. Events can arrive out of
 * order, so clients apply them in revision order: ignore revisions they've
 * already seen, hold back early ones until the gap fills, and reload the
 * board if it doesn't.
 *
 * Optimistic updates: clients apply their own changes immediately and roll
 * them back if the server rejects them. To make that possible, new cards and
 * columns may carry a client-generated id, and moves name the neighbours the
 * item was dropped between rather than an index, so the server can honour
 * the user's intent even if the list changed meanwhile.
 *
 * Resilience: board changes carry an `opId` so a change resent after a
 * dropped connection is applied only once, and a reconnecting client can ask
 * `open_board` for just the changes since the revision it has. The server
 * replies with those changes as ordinary events, or with a full snapshot if
 * it no longer has them all.
 *
 * Card text: a card's title and description are a CRDT document (see
 * crdt.ts), synced separately from the board's ordered changes. Opening a
 * card exchanges state vectors (`card_doc_open` / `card_doc_sync`), then
 * edits flow both ways as `card_doc_update`, relayed to everyone viewing the
 * board. Updates merge in any order and applying one twice is harmless, so
 * these need no opId and no revision. The plain-text title and description
 * on the card itself are refreshed from the document shortly after edits, as
 * an ordinary revisioned `card_upserted`. Cursors and selections travel as
 * `card_awareness`, relayed and never stored.
 */

export const PROTOCOL_VERSION = 6;

// ---- client -> server ----------------------------------------------------

const requestId = z.string().min(1).max(64);

/** Binary CRDT data (updates, state vectors), base64 on the wire. */
const bytes = z.base64().max(400_000);

const request = <T extends string, S extends z.ZodRawShape>(type: T, shape: S) =>
  z.object({ type: z.literal(type), requestId, ...shape });

/**
 * A request that changes a board. `opId` identifies the change itself, not
 * one attempt to send it: a client that resends a change after losing its
 * connection uses the same `opId`, and the server applies it at most once.
 */
const op = <T extends string, S extends z.ZodRawShape>(type: T, shape: S) =>
  request(type, { opId: fields.id, ...shape });

export const ClientMessage = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("ping"),
    /** Client timestamp (ms), echoed back so the client can measure round-trip time. */
    sentAt: z.number(),
  }),

  request("list_boards", {}),
  request("create_board", { name: fields.boardName }),
  op("rename_board", { boardId: fields.id, name: fields.boardName }),
  request("delete_board", { boardId: fields.id }),
  /** Loads a board and subscribes to its changes and presence. */
  request("open_board", {
    boardId: fields.id,
    /** The revision the client already has. If set, the server may reply with only newer changes. */
    sinceRevision: fields.version.optional(),
  }),
  /** Stops receiving a board's changes (e.g. on navigating away). */
  request("close_board", { boardId: fields.id }),
  request("add_member", { boardId: fields.id, email: fields.email }),

  /** Says which card this socket has open (null when none), for card presence. */
  request("focus_card", { boardId: fields.id, cardId: fields.id.nullable() }),

  op("create_column", {
    boardId: fields.id,
    name: fields.columnName,
    /** Client-generated, so the column can be shown before the server replies. */
    id: fields.id.optional(),
  }),
  op("rename_column", { columnId: fields.id, name: fields.columnName }),
  op("move_column", { columnId: fields.id, afterId: fields.anchor, beforeId: fields.anchor }),
  op("delete_column", { columnId: fields.id }),

  op("create_card", {
    columnId: fields.id,
    title: fields.cardTitle,
    /** Client-generated, so the card can be shown before the server replies. */
    id: fields.id.optional(),
  }),
  op("move_card", {
    cardId: fields.id,
    toColumnId: fields.id,
    afterId: fields.anchor,
    beforeId: fields.anchor,
  }),
  op("delete_card", { cardId: fields.id }),

  /** Opens a card's text document: "here's what I have" (a state vector). */
  request("card_doc_open", { boardId: fields.id, cardId: fields.id, stateVector: bytes }),
  /** Edits to a card's text document, to merge and pass on. */
  request("card_doc_update", { boardId: fields.id, cardId: fields.id, update: bytes }),
  /** This client's cursor and selection in a card, for others to see. */
  request("card_awareness", { boardId: fields.id, cardId: fields.id, update: bytes }),
]);
export type ClientMessage = z.infer<typeof ClientMessage>;
export type ClientRequest = Exclude<ClientMessage, { type: "ping" }>;
/** A request before the client has assigned it an id. */
export type ClientRequestBody = ClientRequest extends infer R
  ? R extends ClientRequest
    ? Omit<R, "requestId">
    : never
  : never;

// ---- server -> client ----------------------------------------------------

export const ErrorCode = z.enum([
  "bad_message",
  "unsupported",
  "not_found",
  "forbidden",
  "conflict",
  "internal",
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

/**
 * State events. When an event answers one of this client's requests it
 * carries that request's `requestId`, so the client can tell its own changes
 * apart from everyone else's.
 */
const event = <T extends string, S extends z.ZodRawShape>(type: T, shape: S) =>
  z.object({ type: z.literal(type), requestId: requestId.optional(), ...shape });

/** The board revision an event produced (or, for a snapshot, reflects). */
const revision = z.number().int().min(0);

export const ServerEvent = z.discriminatedUnion("type", [
  event("board_list", { boards: z.array(BoardSummary) }),
  /** `board.role` is always the receiving user's own role. */
  event("board_upserted", { board: BoardSummary, revision }),
  event("board_deleted", { boardId: fields.id }),
  event("board_snapshot", {
    board: BoardSummary,
    revision,
    members: z.array(BoardMember),
    columns: z.array(Column),
    cards: z.array(Card),
  }),
  event("member_added", { boardId: fields.id, revision, member: BoardMember }),
  event("column_upserted", { column: Column, revision }),
  /** Deleting a column also deletes every card in it. */
  event("column_deleted", { boardId: fields.id, columnId: fields.id, revision }),
  event("card_upserted", { card: Card, revision }),
  event("card_deleted", { boardId: fields.id, cardId: fields.id, revision }),
  /** Who has the board open right now, one entry per person. Not revisioned. */
  event("presence", { boardId: fields.id, viewers: z.array(Viewer) }),
  /**
   * Answer to card_doc_open: what the client was missing, and the server's
   * state vector so the client can send back what the server is missing.
   */
  event("card_doc_sync", {
    boardId: fields.id,
    cardId: fields.id,
    update: bytes,
    stateVector: bytes,
  }),
  /** Someone's edits to a card's text. */
  event("card_doc_update", { boardId: fields.id, cardId: fields.id, update: bytes }),
  /** Someone's cursor or selection in a card. */
  event("card_awareness", { boardId: fields.id, cardId: fields.id, update: bytes }),
]);
export type ServerEvent = z.infer<typeof ServerEvent>;

/** Events that change a board's state and carry a revision. */
export type BoardChangeEvent = Extract<ServerEvent, { revision: number }>;

export const ServerMessage = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("welcome"),
    protocolVersion: z.number().int(),
    connectionId: z.string(),
    user: User,
  }),
  z.object({
    type: z.literal("pong"),
    sentAt: z.number(),
    serverTime: z.number(),
  }),
  z.object({ type: z.literal("ack"), requestId }),
  z.object({
    type: z.literal("error"),
    /** Present when the error answers a specific request. */
    requestId: requestId.optional(),
    code: ErrorCode,
    message: z.string(),
  }),
  ...ServerEvent.options,
]);
export type ServerMessage = z.infer<typeof ServerMessage>;

// ---- helpers -------------------------------------------------------------

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

function parseWith<T>(schema: z.ZodType<T>, raw: string): ParseResult<T> {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, error: "invalid JSON" };
  }
  const result = schema.safeParse(json);
  return result.success
    ? { ok: true, value: result.data }
    : { ok: false, error: z.prettifyError(result.error) };
}

export const parseClientMessage = (raw: string) => parseWith(ClientMessage, raw);
export const parseServerMessage = (raw: string) => parseWith(ServerMessage, raw);

/** Best-effort extraction of a request id from a message that failed validation. */
export function salvageRequestId(raw: string): string | undefined {
  try {
    const parsed = requestId.safeParse((JSON.parse(raw) as { requestId?: unknown })?.requestId);
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}
