import { z } from "zod";

/**
 * Domain objects as they travel over the wire. The server is the source of
 * truth; clients render whatever these schemas describe.
 */

export const LIMITS = {
  displayName: 50,
  email: 254,
  passwordMin: 8,
  passwordMax: 200,
  boardName: 100,
  columnName: 100,
  cardTitle: 200,
  cardDescription: 5000,
} as const;

/** Ids the server sends back. Requests use the stricter `fields.id`. */
const id = z.string().min(1).max(64);

/** Trimmed, non-empty string with a maximum length. */
const name = (max: number) => z.string().trim().min(1).max(max);

export const User = z.object({
  id,
  email: z.string(),
  displayName: z.string(),
});
export type User = z.infer<typeof User>;

export const BoardRole = z.enum(["owner", "editor"]);
export type BoardRole = z.infer<typeof BoardRole>;

export const BoardSummary = z.object({
  id,
  name: z.string(),
  /** The current user's role on this board. */
  role: BoardRole,
});
export type BoardSummary = z.infer<typeof BoardSummary>;

export const BoardMember = z.object({
  userId: id,
  email: z.string(),
  displayName: z.string(),
  role: BoardRole,
});
export type BoardMember = z.infer<typeof BoardMember>;

/** Someone who currently has a board open. */
export const Viewer = z.object({ userId: id, displayName: z.string() });
export type Viewer = z.infer<typeof Viewer>;

/**
 * Columns and cards are ordered by `position`: a fractional index key that
 * sorts with plain byte-wise string comparison (not locale-aware comparison).
 */
export const Column = z.object({
  id,
  boardId: id,
  name: z.string(),
  position: z.string(),
});
export type Column = z.infer<typeof Column>;

export const Card = z.object({
  id,
  boardId: id,
  columnId: id,
  title: z.string(),
  description: z.string(),
  position: z.string(),
});
export type Card = z.infer<typeof Card>;

// ---- field validators shared by HTTP and WebSocket requests ---------------

export const fields = {
  /** Every entity id is a database-generated UUID; anything else can't exist. */
  id: z.uuid(),
  displayName: name(LIMITS.displayName),
  email: z.email().max(LIMITS.email),
  boardName: name(LIMITS.boardName),
  columnName: name(LIMITS.columnName),
  cardTitle: name(LIMITS.cardTitle),
  cardDescription: z.string().max(LIMITS.cardDescription),
  /** Target index within the destination list, counted without the item being moved. */
  index: z.number().int().min(0),
};

/** Byte-wise comparison, matching the server's `COLLATE "C"` ordering of positions. */
export function comparePositions(a: { position: string }, b: { position: string }): number {
  return a.position < b.position ? -1 : a.position > b.position ? 1 : 0;
}
