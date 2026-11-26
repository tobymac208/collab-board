import { z } from "zod";
import { BoardMember, BoardSummary, Card, Column, User, fields } from "./model.ts";

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
 */

export const PROTOCOL_VERSION = 2;

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
  request("open_board", { boardId: fields.id }),
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

export const ServerEvent = z.discriminatedUnion("type", [
  event("board_list", { boards: z.array(BoardSummary) }),
  event("board_upserted", { board: BoardSummary }),
  event("board_deleted", { boardId: fields.id }),
  event("board_snapshot", {
    board: BoardSummary,
    members: z.array(BoardMember),
    columns: z.array(Column),
    cards: z.array(Card),
  }),
  event("member_added", { boardId: fields.id, member: BoardMember }),
  event("column_upserted", { column: Column }),
  /** Deleting a column also deletes every card in it. */
  event("column_deleted", { boardId: fields.id, columnId: fields.id }),
  event("card_upserted", { card: Card }),
  event("card_deleted", { boardId: fields.id, cardId: fields.id }),
]);
export type ServerEvent = z.infer<typeof ServerEvent>;

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
