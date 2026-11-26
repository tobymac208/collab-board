import { z } from "zod";

/**
 * Wire protocol between the browser and the WebSocket server.
 *
 * Every message is a JSON object with a `type` discriminator. Both sides parse
 * incoming messages with these schemas, so a malformed message is rejected at
 * the edge instead of propagating as `any`.
 */

export const PROTOCOL_VERSION = 1;

// ---- client -> server ----------------------------------------------------

export const ClientMessage = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("ping"),
    /** Client timestamp (ms), echoed back so the client can measure round-trip time. */
    sentAt: z.number(),
  }),
]);
export type ClientMessage = z.infer<typeof ClientMessage>;

// ---- server -> client ----------------------------------------------------

export const ServerMessage = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("welcome"),
    protocolVersion: z.number().int(),
    connectionId: z.string(),
  }),
  z.object({
    type: z.literal("pong"),
    sentAt: z.number(),
    serverTime: z.number(),
  }),
  z.object({
    type: z.literal("error"),
    code: z.enum(["bad_message", "unsupported"]),
    message: z.string(),
  }),
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
