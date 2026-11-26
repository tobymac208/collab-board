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
 */

export const PROTOCOL_VERSION = 3;

// ---- client -> server ----------------------------------------------------

const requestId = z.string().min(1).max(64);

const request = <T extends string, S extends z.ZodRawShape>(type: T, shape: S) =>
  z.object({ type: z.literal(type), requestId, ...shape });

export const ClientMessage = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("ping"),
    /** Client timestamp (ms), echoed back so the client can measure round-trip time. */
    sentAt: z.number(),
  }),

  request("list_boards", {}),
  request("create_board", { name: fields.boardName }),
  request("rename_board", { boardId: fields.id, name: fields.boardName }),
  request("delete_board", { boardId: fields.id }),
  /** Loads a board and subscribes to its changes and presence. */
  request("open_board", { boardId: fields.id }),
  /** Stops receiving a board's changes (e.g. on navigating away). */
  request("close_board", { boardId: fields.id }),
  request("add_member", { boardId: fields.id, email: fields.email }),

  request("create_column", { boardId: fields.id, name: fields.columnName }),
  request("rename_column", { columnId: fields.id, name: fields.columnName }),
  request("move_column", { columnId: fields.id, toIndex: fields.index }),
  request("delete_column", { columnId: fields.id }),

  request("create_card", { columnId: fields.id, title: fields.cardTitle }),
  request("update_card", {
    cardId: fields.id,
    title: fields.cardTitle.optional(),
    description: fields.cardDescription.optional(),
  }),
  request("move_card", { cardId: fields.id, toColumnId: fields.id, toIndex: fields.index }),
  request("delete_card", { cardId: fields.id }),
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
