"use client";

import { createContext, useContext } from "react";
import type { Viewer } from "@collab/shared";
import type { BoardOp } from "@/lib/board-state";
import type { RequestError } from "@/lib/sync-client";

export type MutationResult = { ok: true } | { ok: false; error: RequestError };

export interface BoardContextValue {
  /**
   * Applies a change optimistically and sends it. Failures roll back and are
   * reported to the user, unless `quiet` (the caller handles them).
   */
  mutate: (op: BoardOp, options?: { quiet?: boolean }) => Promise<MutationResult>;
  /** Other people who have this card open (never includes the current user). */
  othersOnCard: (cardId: string) => Viewer[];
}

export const BoardContext = createContext<BoardContextValue | null>(null);

export function useBoard(): BoardContextValue {
  const ctx = useContext(BoardContext);
  if (!ctx) throw new Error("useBoard must be used inside a board");
  return ctx;
}
