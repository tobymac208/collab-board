"use client";

import { createContext, useContext } from "react";
import type { Viewer } from "@collab/shared";
import type { BoardOp } from "@/lib/board-state";
import type { CardDocs } from "@/lib/card-docs";
import type { RequestError } from "@/lib/sync-client";

/**
 * How a change went. `queued`: offline (or the connection dropped), so it's
 * saved and will be sent later; if it's refused then, it shows up for review.
 */
export type MutationResult = { ok: true; queued?: boolean } | { ok: false; error: RequestError };

/** A board change as callers write it; `mutate` gives it an opId. */
export type NewBoardOp = BoardOp extends infer O
  ? O extends BoardOp
    ? Omit<O, "opId">
    : never
  : never;

export interface BoardContextValue {
  /**
   * Applies a change optimistically and sends it. Failures roll back and are
   * reported to the user, unless `quiet` (the caller handles them).
   */
  mutate: (op: NewBoardOp, options?: { quiet?: boolean }) => Promise<MutationResult>;
  /** Other people who have this card open (never includes the current user). */
  othersOnCard: (cardId: string) => Viewer[];
  /** Card text documents (titles and descriptions, edited live). */
  cardDocs: CardDocs;
  /** The board is connected and caught up. */
  live: boolean;
  /** How the current user appears to others in a card (cursor label and colour). */
  me: { name: string; color: string };
}

export const BoardContext = createContext<BoardContextValue | null>(null);

export function useBoard(): BoardContextValue {
  const ctx = useContext(BoardContext);
  if (!ctx) throw new Error("useBoard must be used inside a board");
  return ctx;
}
