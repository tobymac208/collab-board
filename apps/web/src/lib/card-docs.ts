import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from "y-protocols/awareness";
import {
  applyUpdate,
  diffSince,
  encodeState,
  encodeStateVector,
  fromBase64,
  isEmptyUpdate,
  isUndoOrigin,
  loadCardDoc,
  mergeUpdates,
  newCardDoc,
  onDocUpdate,
  seedUpdate,
  toBase64,
  type CardDoc,
  type ClientRequestBody,
  type ServerEvent,
} from "@collab/shared";

/** Origin of edits typed in this browser (as opposed to merged from others). */
export const LOCAL = Symbol("local edit");
const REMOTE = "remote";

/** How long to gather keystrokes before sending them (a fixed window, not a pause). */
const SEND_DELAY_MS = 150;
/** Retry delays after a failed send or sync grow up to this. */
const MAX_RETRY_MS = 30_000;

/** Typed here, or undo/redo of something typed here: either way, ours to send. */
const isLocal = (origin: unknown) => origin === LOCAL || isUndoOrigin(origin);

export interface CardDocEntry {
  cardId: string;
  doc: CardDoc;
  /** Other people's cursors and selections in this card, and ours. */
  awareness: Awareness;
  /** Has text the server may not have yet (typed offline, or not yet acknowledged). */
  dirty: boolean;
  /** Has been synced with the server since this page loaded. */
  synced: boolean;
}

/** What gets saved in the browser for each card document. */
export interface SavedDoc {
  state: string;
  dirty: boolean;
}

type Send = (body: ClientRequestBody) => Promise<ServerEvent[]>;

interface Internal extends CardDocEntry {
  /** Local updates not sent yet. */
  pending: Uint8Array[];
  /** Sends waiting for an ack. */
  inFlight: number;
  /** Must exchange state with the server before trusting `pending` (after a disconnect). */
  needsSync: boolean;
  timer: ReturnType<typeof setTimeout> | undefined;
  /** Failed sends/syncs in a row, for backing off retries. */
  failures: number;
  retryTimer: ReturnType<typeof setTimeout> | undefined;
}

/**
 * The card text documents this browser has open, for one board.
 *
 * - Local edits are batched and sent while live. Offline they just stay in
 *   the document, which is saved in the browser.
 * - On every (re)connect each document re-syncs by exchanging state vectors:
 *   the server sends what we're missing, we send what it's missing. That's
 *   how offline edits get through, with nothing to queue or replay, and CRDT
 *   merging means nothing to conflict.
 * - Cursors (awareness) are relayed live and never saved.
 *
 * React reads it through `subscribe`/`version`, like an external store.
 */
export class CardDocs {
  #entries = new Map<string, Internal>();
  #live = false;
  /** Cards created here that the server doesn't have yet: their text waits. */
  #unconfirmed = new Set<string>();
  #listeners = new Set<() => void>();
  #version = 0;

  constructor(
    private readonly boardId: string,
    private readonly send: Send,
    private readonly onError: (message: string) => void,
  ) {}

  // ---- external store ----------------------------------------------------

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  /** Changes whenever any document, its dirty state, or a cursor changes. */
  version = (): number => this.#version;

  #changed(): void {
    this.#version++;
    for (const listener of this.#listeners) listener();
  }

  // ---- documents ---------------------------------------------------------

  get(cardId: string): CardDocEntry | undefined {
    return this.#entries.get(cardId);
  }

  /** Every open document (e.g. to show live titles on the board). */
  entries(): CardDocEntry[] {
    return [...this.#entries.values()];
  }

  /** How many documents have text the server may not have yet. */
  dirtyCount(): number {
    let n = 0;
    for (const entry of this.#entries.values()) if (entry.dirty) n++;
    return n;
  }

  /**
   * Opens a card's document. Online it syncs with the server. Offline it can
   * only start from a seed: the card's creation text, which seeds identically
   * on the server (see `seedUpdate`), so pass `seed` only for cards whose text
   * hasn't changed since they were created. Returns undefined when neither is
   * possible (offline, never opened, already edited).
   */
  open(cardId: string, seed?: { title: string; description: string }): CardDocEntry | undefined {
    const existing = this.#entries.get(cardId);
    if (existing) {
      if (this.#live && !existing.synced) void this.#sync(existing);
      return existing;
    }
    if (!this.#live && !seed) return undefined;
    const entry = this.#create(cardId, newCardDoc(), false);
    if (seed) applyUpdate(entry.doc, seedUpdate(seed.title, seed.description), REMOTE);
    if (this.#live) void this.#sync(entry);
    this.#changed();
    return entry;
  }

  #create(cardId: string, doc: CardDoc, dirty: boolean): Internal {
    const entry: Internal = {
      cardId,
      doc,
      awareness: new Awareness(doc),
      dirty,
      synced: false,
      pending: [],
      inFlight: 0,
      needsSync: dirty,
      timer: undefined,
      failures: 0,
      retryTimer: undefined,
    };
    entry.awareness.setLocalState(null); // nobody's here until the editor says so
    onDocUpdate(doc, (update, origin) => {
      if (isLocal(origin)) {
        entry.pending.push(update);
        entry.dirty = true;
        this.#schedule(entry);
      }
      this.#changed();
    });
    entry.awareness.on(
      "update",
      (
        { added, updated, removed }: Record<"added" | "updated" | "removed", number[]>,
        origin: unknown,
      ) => {
        this.#changed();
        if (origin === REMOTE || !this.#live) return;
        const changed = [...added, ...updated, ...removed];
        void this.send({
          type: "card_awareness",
          boardId: this.boardId,
          cardId,
          update: toBase64(encodeAwarenessUpdate(entry.awareness, changed)),
        }).catch(() => {});
      },
    );
    this.#entries.set(cardId, entry);
    return entry;
  }

  // ---- talking to the server ---------------------------------------------

  /**
   * Cards created in this browser whose creation the server hasn't confirmed.
   * Their text can't sync yet (the server would say "card not found"); once a
   * card drops out of this set, its document syncs.
   */
  setUnconfirmed(cardIds: Iterable<string>): void {
    const next = new Set(cardIds);
    const confirmed = [...this.#unconfirmed].filter((id) => !next.has(id));
    this.#unconfirmed = next;
    if (!this.#live) return;
    for (const id of confirmed) {
      const entry = this.#entries.get(id);
      if (entry && !entry.synced) void this.#sync(entry);
    }
  }

  /** Called whenever the board becomes live (caught up) or stops being. */
  setLive(live: boolean): void {
    if (live === this.#live) return;
    this.#live = live;
    if (!live) {
      for (const entry of this.#entries.values()) {
        clearTimeout(entry.timer);
        clearTimeout(entry.retryTimer);
        entry.timer = entry.retryTimer = undefined;
        entry.synced = false;
        // Whatever was in flight may or may not have arrived: re-sync to be sure.
        if (entry.dirty) entry.needsSync = true;
      }
      this.#changed();
      return;
    }
    for (const entry of this.#entries.values()) void this.#sync(entry);
  }

  /** Exchanges state with the server: take what we lack, send what it lacks. */
  async #sync(entry: Internal): Promise<void> {
    if (this.#unconfirmed.has(entry.cardId)) {
      entry.needsSync = true; // after the server confirms the card
      return;
    }
    clearTimeout(entry.retryTimer);
    entry.retryTimer = undefined;
    entry.needsSync = false;
    try {
      const [reply] = await this.send({
        type: "card_doc_open",
        boardId: this.boardId,
        cardId: entry.cardId,
        stateVector: toBase64(encodeStateVector(entry.doc)),
      });
      if (reply?.type !== "card_doc_sync") return;
      applyUpdate(entry.doc, fromBase64(reply.update), REMOTE);
      // Everything typed so far is covered by this diff.
      entry.pending.splice(0);
      const missing = diffSince(entry.doc, fromBase64(reply.stateVector));
      if (!isEmptyUpdate(missing)) await this.#push(entry, missing);
      entry.synced = true;
      entry.failures = 0;
      this.#settle(entry);
    } catch (err) {
      entry.needsSync = true;
      this.#failed(entry, err);
    }
  }

  /**
   * Sends pending edits within a fixed window of the first keystroke, rather
   * than waiting for a pause, so others see continuous typing as it happens.
   */
  #schedule(entry: Internal): void {
    if (!this.#live || entry.needsSync || !entry.synced) return; // the next sync covers it
    if (entry.timer) return; // a send is already coming
    entry.timer = setTimeout(() => {
      entry.timer = undefined;
      void this.#flush(entry);
    }, SEND_DELAY_MS);
  }

  async #flush(entry: Internal): Promise<void> {
    if (entry.pending.length === 0 || !this.#live) return;
    const update = mergeUpdates(entry.pending.splice(0));
    try {
      await this.#push(entry, update);
    } catch (err) {
      // The edits are still in the document; a resync sends them, along with
      // anything typed since.
      entry.needsSync = true;
      this.#failed(entry, err);
    }
    this.#settle(entry);
  }

  async #push(entry: Internal, update: Uint8Array): Promise<void> {
    entry.inFlight++;
    try {
      await this.send({
        type: "card_doc_update",
        boardId: this.boardId,
        cardId: entry.cardId,
        update: toBase64(update),
      });
    } finally {
      entry.inFlight--;
    }
  }

  /** Clean once nothing is waiting to be sent or acknowledged. */
  #settle(entry: Internal): void {
    const dirty = entry.needsSync || entry.pending.length > 0 || entry.inFlight > 0;
    if (dirty !== entry.dirty) {
      entry.dirty = dirty;
      this.#changed();
    }
    if (entry.pending.length > 0) this.#schedule(entry);
  }

  /**
   * After a failed send or sync. A disconnect needs nothing more: going live
   * again resyncs. Anything else is retried while still connected, with
   * growing delays, and reported once rather than on every attempt.
   */
  #failed(entry: Internal, err: unknown): void {
    const code = (err as { code?: string }).code;
    if (code === "disconnected") return;
    entry.failures++;
    if (entry.failures === 1) this.onError((err as Error).message);
    if (code === "not_found" || !this.#live) return; // card gone, or reconnect will retry
    clearTimeout(entry.retryTimer);
    const delay = Math.min(MAX_RETRY_MS, 1000 * 2 ** (entry.failures - 1));
    entry.retryTimer = setTimeout(() => void this.#sync(entry), delay);
  }

  /** Server events: other people's edits and cursors. */
  handle(event: ServerEvent): void {
    if (event.type === "card_doc_update" && event.boardId === this.boardId) {
      const entry = this.#entries.get(event.cardId);
      if (entry) applyUpdate(entry.doc, fromBase64(event.update), REMOTE);
    } else if (event.type === "card_awareness" && event.boardId === this.boardId) {
      const entry = this.#entries.get(event.cardId);
      if (entry) applyAwarenessUpdate(entry.awareness, fromBase64(event.update), REMOTE);
    }
  }

  // ---- saved in the browser ---------------------------------------------

  export(): Record<string, SavedDoc> {
    const saved: Record<string, SavedDoc> = {};
    for (const entry of this.#entries.values()) {
      saved[entry.cardId] = { state: toBase64(encodeState(entry.doc)), dirty: entry.dirty };
    }
    return saved;
  }

  /** Loads saved documents; merges into ones already open. */
  import(saved: Record<string, SavedDoc>): void {
    for (const [cardId, { state, dirty }] of Object.entries(saved)) {
      const bytes = fromBase64(state);
      const existing = this.#entries.get(cardId);
      if (existing) {
        applyUpdate(existing.doc, bytes, REMOTE);
        if (dirty) existing.needsSync = existing.dirty = true;
      } else {
        this.#create(cardId, loadCardDoc(bytes), dirty);
      }
      const entry = this.#entries.get(cardId)!;
      if (this.#live && (entry.needsSync || !entry.synced)) void this.#sync(entry);
    }
    this.#changed();
  }

  /** Forgets a document (its card was deleted). */
  drop(cardId: string): void {
    const entry = this.#entries.get(cardId);
    if (!entry) return;
    clearTimeout(entry.timer);
    clearTimeout(entry.retryTimer);
    entry.awareness.destroy();
    entry.doc.destroy();
    this.#entries.delete(cardId);
    this.#changed();
  }

  destroy(): void {
    for (const cardId of [...this.#entries.keys()]) this.drop(cardId);
  }
}
