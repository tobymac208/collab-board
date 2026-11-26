import type { WebSocket } from "ws";
import type { ServerEvent, User, Viewer } from "@collab/shared";

/**
 * Who is connected, and who is looking at which board.
 *
 * Fans events out to the sockets of a board's viewers or of a user. It lives
 * in memory, so it only knows about sockets on this server process; phase 6
 * puts Redis pub/sub behind the same methods to span several servers.
 */
export class Hub {
  #sockets = new Map<WebSocket, { user: User; boardId: string | null; cardId: string | null }>();
  #byUser = new Map<string, Set<WebSocket>>();
  #byBoard = new Map<string, Set<WebSocket>>();

  add(socket: WebSocket, user: User): void {
    this.#sockets.set(socket, { user, boardId: null, cardId: null });
    addTo(this.#byUser, user.id, socket);
  }

  /** Forgets a socket (on disconnect), updating presence for its board. */
  remove(socket: WebSocket): void {
    const entry = this.#sockets.get(socket);
    if (!entry) return;
    this.#leave(socket);
    removeFrom(this.#byUser, entry.user.id, socket);
    this.#sockets.delete(socket);
  }

  /** Subscribes a socket to a board, replacing any board it had open. */
  open(socket: WebSocket, boardId: string): void {
    const entry = this.#sockets.get(socket);
    if (!entry || entry.boardId === boardId) return;
    this.#leave(socket);
    entry.boardId = boardId;
    entry.cardId = null;
    addTo(this.#byBoard, boardId, socket);
    this.#broadcastPresence(boardId);
  }

  /** Unsubscribes a socket from a board, if that's the board it has open. */
  close(socket: WebSocket, boardId: string): void {
    if (this.#sockets.get(socket)?.boardId === boardId) this.#leave(socket);
  }

  /** Records which card a viewer has open, if they're viewing that board. */
  focus(socket: WebSocket, boardId: string, cardId: string | null): void {
    const entry = this.#sockets.get(socket);
    if (!entry || entry.boardId !== boardId || entry.cardId === cardId) return;
    entry.cardId = cardId;
    this.#broadcastPresence(boardId);
  }

  /** Unsubscribes everyone from a board that no longer exists. */
  dropBoard(boardId: string): void {
    for (const socket of this.#byBoard.get(boardId) ?? []) {
      const entry = this.#sockets.get(socket);
      if (entry) {
        entry.boardId = null;
        entry.cardId = null;
      }
    }
    this.#byBoard.delete(boardId);
  }

  /** Sends to everyone viewing a board, except `except` (usually the requester). */
  toBoard(boardId: string, event: ServerEvent, except?: WebSocket): void {
    send(this.#byBoard.get(boardId), event, except);
  }

  /** Sends to every socket a user has open, except `except`. */
  toUser(userId: string, event: ServerEvent, except?: WebSocket): void {
    send(this.#byUser.get(userId), event, except);
  }

  /**
   * Everyone viewing a board, once per person however many tabs they have,
   * with the cards they have open across those tabs.
   */
  viewers(boardId: string): Viewer[] {
    const people = new Map<string, Viewer>();
    for (const socket of this.#byBoard.get(boardId) ?? []) {
      const entry = this.#sockets.get(socket);
      if (!entry) continue;
      const viewer = people.get(entry.user.id) ?? {
        userId: entry.user.id,
        displayName: entry.user.displayName,
        cardIds: [],
      };
      if (entry.cardId && !viewer.cardIds.includes(entry.cardId)) viewer.cardIds.push(entry.cardId);
      people.set(entry.user.id, viewer);
    }
    return [...people.values()];
  }

  #leave(socket: WebSocket): void {
    const entry = this.#sockets.get(socket);
    if (!entry?.boardId) return;
    const boardId = entry.boardId;
    entry.boardId = null;
    entry.cardId = null;
    removeFrom(this.#byBoard, boardId, socket);
    this.#broadcastPresence(boardId);
  }

  #broadcastPresence(boardId: string): void {
    this.toBoard(boardId, { type: "presence", boardId, viewers: this.viewers(boardId) });
  }
}

function addTo<K, V>(map: Map<K, Set<V>>, key: K, value: V): void {
  const set = map.get(key) ?? new Set();
  set.add(value);
  map.set(key, set);
}

function removeFrom<K, V>(map: Map<K, Set<V>>, key: K, value: V): void {
  const set = map.get(key);
  if (!set) return;
  set.delete(value);
  if (set.size === 0) map.delete(key);
}

function send(sockets: Set<WebSocket> | undefined, event: ServerEvent, except?: WebSocket): void {
  if (!sockets) return;
  const data = JSON.stringify(event); // serialize once for all recipients
  for (const socket of sockets) {
    if (socket !== except && socket.readyState === socket.OPEN) socket.send(data);
  }
}
