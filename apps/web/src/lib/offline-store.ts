import { PROTOCOL_VERSION, fromBase64, mergeUpdates, toBase64 } from "@collab/shared";
import type { BoardState, LocalOp, RejectedOp } from "./board-state";
import type { SavedDoc } from "./card-docs";

/**
 * Saves each open board, and the user's unsent changes to it, in the
 * browser's localStorage, so a reload (or closing the tab) doesn't lose work
 * made offline. On the next visit the board shows from the saved copy at
 * once, then catches up with the server and sends the saved changes.
 *
 * Keys include the user, so people sharing a browser never see each other's
 * data, and the protocol version, so a protocol change quietly discards saved
 * state instead of misreading it.
 *
 * Tabs: each tab saves under its own key, so two tabs on the same board can't
 * overwrite each other's queue. A tab holds a Web Lock named after itself for
 * as long as it's open; when a board opens, saved queues of tabs whose lock is
 * free (closed tabs) are adopted and their keys removed. Adoption takes the
 * dead tab's lock first, so two live tabs never adopt the same queue.
 * Re-sending an adopted change is safe: the server applies each opId once.
 */

export interface SavedBoard {
  data: BoardState | null;
  ops: LocalOp[];
  rejected: RejectedOp[];
  /** Card text documents opened on this board, by card id. */
  docs?: Record<string, SavedDoc>;
}

const PREFIX = "collab-board";
const userPrefix = (userId: string) => `${PREFIX}:v${PROTOCOL_VERSION}:${userId}:`;
const boardPrefix = (userId: string, boardId: string) => `${userPrefix(userId)}board:${boardId}:`;
const tabLock = (tabId: string) => `${PREFIX}:tab:${tabId}`;

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null; // blocked (e.g. some privacy modes)
  }
}

const locks = (): LockManager | null =>
  typeof navigator !== "undefined" && "locks" in navigator ? navigator.locks : null;

// ---- this tab's identity ----------------------------------------------------

let tabId: string | null = null;

/**
 * A stable id for this tab: kept in sessionStorage so it survives a reload,
 * and backed by a held Web Lock so "Duplicate tab" (which copies
 * sessionStorage) doesn't give two live tabs the same id.
 */
async function currentTab(): Promise<string> {
  if (tabId) return tabId;
  const manager = locks();
  let candidate: string | null = null;
  try {
    candidate = window.sessionStorage.getItem(`${PREFIX}:tab-id`);
  } catch {
    // sessionStorage unavailable: fall through to a fresh id
  }
  for (;;) {
    candidate ??= crypto.getRandomValues(new Uint32Array(2)).join("-");
    if (!manager) break;
    const acquired = await new Promise<boolean>((resolve) => {
      void manager.request(tabLock(candidate!), { ifAvailable: true }, (lock) => {
        resolve(lock !== null);
        // Hold it for the life of the page.
        return lock ? new Promise<void>(() => {}) : undefined;
      });
    });
    if (acquired) break;
    candidate = null; // a live tab already uses this id (duplicated tab)
  }
  try {
    window.sessionStorage.setItem(`${PREFIX}:tab-id`, candidate);
  } catch {
    // fine: the id just won't survive a reload
  }
  tabId = candidate;
  return candidate;
}

// ---- reading and writing ------------------------------------------------

function read(key: string): SavedBoard | null {
  const raw = storage()?.getItem(key);
  if (!raw) return null;
  try {
    const saved = JSON.parse(raw) as Partial<SavedBoard>;
    if (!Array.isArray(saved.ops) || !Array.isArray(saved.rejected)) return null;
    return {
      data: saved.data ?? null,
      ops: saved.ops,
      rejected: saved.rejected,
      docs: saved.docs ?? {},
    };
  } catch {
    return null;
  }
}

/** Every key starting with `prefix`. */
function keysWith(prefix: string): string[] {
  const store = storage();
  if (!store) return [];
  const keys: string[] = [];
  for (let i = 0; i < store.length; i++) {
    const key = store.key(i);
    if (key?.startsWith(prefix)) keys.push(key);
  }
  return keys;
}

/**
 * Combines saved copies: the newest board data, every change once, and card
 * documents merged (they're CRDTs, so text typed offline in two tabs that
 * have since closed is all kept).
 */
function merge(copies: SavedBoard[]): SavedBoard | null {
  if (copies.length === 0) return null;
  let data: BoardState | null = null;
  const ops = new Map<string, LocalOp>();
  const rejected = new Map<string, RejectedOp>();
  const docs: Record<string, SavedDoc> = {};
  for (const copy of copies) {
    if (copy.data && (!data || copy.data.revision > data.revision)) data = copy.data;
    for (const op of copy.ops) if (!ops.has(op.op.opId)) ops.set(op.op.opId, op);
    for (const r of copy.rejected) if (!rejected.has(r.op.opId)) rejected.set(r.op.opId, r);
    for (const [cardId, doc] of Object.entries(copy.docs ?? {})) {
      const known = docs[cardId];
      docs[cardId] = known
        ? {
            state: toBase64(mergeUpdates([fromBase64(known.state), fromBase64(doc.state)])),
            dirty: known.dirty || doc.dirty,
          }
        : doc;
    }
  }
  return { data, ops: [...ops.values()], rejected: [...rejected.values()], docs };
}

/**
 * This tab's saved copy of a board, plus anything saved by tabs that have
 * since closed (their entries are removed once adopted).
 */
export async function restoreBoard(userId: string, boardId: string): Promise<SavedBoard | null> {
  if (!storage()) return null;
  const me = await currentTab();
  const prefix = boardPrefix(userId, boardId);
  const mine = read(`${prefix}tab:${me}`);
  const adopted: SavedBoard[] = [];
  const manager = locks();
  if (manager) {
    for (const key of keysWith(prefix)) {
      const owner = key.slice(`${prefix}tab:`.length);
      if (owner === me) continue;
      // Free lock = the owning tab is gone. Hold it while adopting.
      await manager.request(tabLock(owner), { ifAvailable: true }, async (lock) => {
        if (!lock) return; // that tab is still open: its queue is its own
        const saved = read(key);
        if (saved) adopted.push(saved);
        storage()?.removeItem(key);
      });
    }
  }
  return merge([...(mine ? [mine] : []), ...adopted]);
}

/** Saves this tab's copy. Returns false if it couldn't be saved (full or blocked). */
export async function saveBoard(
  userId: string,
  boardId: string,
  board: SavedBoard,
): Promise<boolean> {
  const store = storage();
  if (!store) return false;
  try {
    store.setItem(
      `${boardPrefix(userId, boardId)}tab:${await currentTab()}`,
      JSON.stringify(board),
    );
    return true;
  } catch {
    return false;
  }
}

/** Forgets every saved copy of a board (it was deleted, or the user lost access). */
export function forgetBoard(userId: string, boardId: string): void {
  for (const key of keysWith(boardPrefix(userId, boardId))) storage()?.removeItem(key);
}

/** How many changes (and card texts) this user has that haven't reached the server yet. */
export function countUnsent(userId: string): number {
  const unsent = new Set<string>(); // by opId / card: adopted copies may overlap
  for (const key of keysWith(userPrefix(userId))) {
    const saved = read(key);
    for (const op of saved?.ops ?? []) {
      if (op.confirmedAt === undefined) unsent.add(op.op.opId);
    }
    for (const [cardId, doc] of Object.entries(saved?.docs ?? {})) {
      if (doc.dirty) unsent.add(`text:${cardId}`);
    }
  }
  return unsent.size;
}

/** Forgets everything saved for this user (on logout). */
export function clearUser(userId: string): void {
  for (const key of keysWith(userPrefix(userId))) storage()?.removeItem(key);
}

/** For tests: forget this tab's identity, as if the page had been reloaded. */
export function resetTabForTests(): void {
  tabId = null;
}
