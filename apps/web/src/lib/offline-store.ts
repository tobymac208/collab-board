import { PROTOCOL_VERSION } from "@collab/shared";
import type { BoardState, LocalOp, RejectedOp } from "./board-state";

/**
 * Saves each open board, and the user's unsent changes to it, in the
 * browser's localStorage, so a reload (or closing the tab) doesn't lose work
 * made offline. On the next visit the board shows from the saved copy at
 * once, then catches up with the server and sends the saved changes.
 *
 * Keys include the user, so people sharing a browser never see each other's
 * data, and the protocol version, so a protocol change quietly discards saved
 * state instead of misreading it.
 */

export interface SavedBoard {
  data: BoardState | null;
  ops: LocalOp[];
  rejected: RejectedOp[];
}

const PREFIX = "collab-board";
const userPrefix = (userId: string) => `${PREFIX}:v${PROTOCOL_VERSION}:${userId}:`;
const boardKey = (userId: string, boardId: string) => `${userPrefix(userId)}board:${boardId}`;

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null; // blocked (e.g. some privacy modes)
  }
}

export function loadBoard(userId: string, boardId: string): SavedBoard | null {
  const raw = storage()?.getItem(boardKey(userId, boardId));
  if (!raw) return null;
  try {
    const saved = JSON.parse(raw) as Partial<SavedBoard>;
    if (!Array.isArray(saved.ops) || !Array.isArray(saved.rejected)) return null;
    return { data: saved.data ?? null, ops: saved.ops, rejected: saved.rejected };
  } catch {
    return null;
  }
}

export function saveBoard(userId: string, boardId: string, board: SavedBoard): void {
  const store = storage();
  if (!store) return;
  try {
    store.setItem(boardKey(userId, boardId), JSON.stringify(board));
  } catch {
    // Full or unavailable: the app still works, it just can't save offline work.
  }
}

/** Forgets a saved board (it was deleted, or the user lost access). */
export function forgetBoard(userId: string, boardId: string): void {
  storage()?.removeItem(boardKey(userId, boardId));
}

/** Every saved board key for this user. */
function keysFor(userId: string): string[] {
  const store = storage();
  if (!store) return [];
  const prefix = userPrefix(userId);
  const keys: string[] = [];
  for (let i = 0; i < store.length; i++) {
    const key = store.key(i);
    if (key?.startsWith(prefix)) keys.push(key);
  }
  return keys;
}

/** How many changes this user has that haven't reached the server yet. */
export function countUnsent(userId: string): number {
  let count = 0;
  for (const key of keysFor(userId)) {
    try {
      const saved = JSON.parse(storage()!.getItem(key) ?? "{}") as Partial<SavedBoard>;
      count += (saved.ops ?? []).filter((o) => o.confirmedAt === undefined).length;
    } catch {
      // ignore unreadable entries
    }
  }
  return count;
}

/** Forgets everything saved for this user (on logout). */
export function clearUser(userId: string): void {
  for (const key of keysFor(userId)) storage()?.removeItem(key);
}
