import * as Y from "yjs";

/**
 * Card text as a CRDT (phase 5a: Yjs).
 *
 * Each card has one document holding two text fields. Edits from anyone, in
 * any order, merge character by character, and applying the same update
 * twice is harmless, so there's nothing to conflict and nothing to dedupe.
 *
 * The rest of the app only uses the functions below; 5b replaces their
 * implementation with a hand-rolled CRDT without touching the callers.
 * Updates and state vectors travel as bytes (base64 on the wire).
 */

export type CardDoc = Y.Doc;
export const CARD_TEXT_FIELDS = ["title", "description"] as const;
export type CardTextField = (typeof CARD_TEXT_FIELDS)[number];

/** Upper bound for a stored card document, tombstones included. */
export const MAX_CARD_DOC_BYTES = 256 * 1024;

export function newCardDoc(): CardDoc {
  return new Y.Doc();
}

/** A document from its encoded state (as stored, or as saved offline). */
export function loadCardDoc(state: Uint8Array): CardDoc {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, state);
  return doc;
}

const SEED_CLIENT_ID = 0;

/**
 * The first update of a card's document, built from its text at that point.
 *
 * Deterministic: the same title and description always give the same bytes
 * (a fixed client id and fixed operation order). So when the server seeds a
 * card from its stored text and a browser seeds the same card offline from
 * the same text, the two seeds are one and the same edit, and merging them
 * doesn't duplicate the title.
 */
export function seedUpdate(title: string, description: string): Uint8Array {
  const doc = new Y.Doc();
  doc.clientID = SEED_CLIENT_ID;
  doc.transact(() => {
    if (title) doc.getText("title").insert(0, title);
    if (description) doc.getText("description").insert(0, description);
  });
  return Y.encodeStateAsUpdate(doc);
}

export const encodeState = (doc: CardDoc): Uint8Array => Y.encodeStateAsUpdate(doc);

/** A summary of what a document contains, for asking a peer what's missing. */
export const encodeStateVector = (doc: CardDoc): Uint8Array => Y.encodeStateVector(doc);

/** Everything in `doc` that a peer with `stateVector` doesn't have yet. */
export const diffSince = (doc: CardDoc, stateVector: Uint8Array): Uint8Array =>
  Y.encodeStateAsUpdate(doc, stateVector);

/**
 * Merges `update` into `doc`. Returns whether that changed anything: false
 * for an update the document already contained (a resend, or an echo).
 *
 * An update can arrive before one it depends on; Yjs then holds it as
 * "pending" until the gap fills, so the visible snapshot doesn't change yet.
 * That still counts as a change: the document now holds something new that
 * must be saved and passed on, or it would be lost.
 */
export function applyUpdate(doc: CardDoc, update: Uint8Array, origin?: unknown): boolean {
  const before = Y.snapshot(doc);
  const pendingBefore = pendingSignature(doc);
  Y.applyUpdate(doc, update, origin);
  return !Y.equalSnapshots(before, Y.snapshot(doc)) || pendingSignature(doc) !== pendingBefore;
}

/** A summary of updates Yjs is holding until their dependencies arrive. */
function pendingSignature(doc: CardDoc): string {
  const { pendingStructs, pendingDs } = doc.store;
  const structs = pendingStructs ? toBase64(pendingStructs.update) : "";
  const deletes = pendingDs ? toBase64(pendingDs) : "";
  return `${structs}|${deletes}`;
}

/** Combines several updates into one (e.g. a batch of keystrokes). */
export const mergeUpdates = (updates: Uint8Array[]): Uint8Array => Y.mergeUpdates(updates);

export const readText = (doc: CardDoc, field: CardTextField): string =>
  doc.getText(field).toString();

/** Replaces `deleteCount` characters at `index` with `insert`, as one change. */
export function editText(
  doc: CardDoc,
  field: CardTextField,
  index: number,
  deleteCount: number,
  insert: string,
  origin?: unknown,
): void {
  const text = doc.getText(field);
  doc.transact(() => {
    if (deleteCount > 0) text.delete(index, deleteCount);
    if (insert) text.insert(index, insert);
  }, origin);
}

/** Calls `listener` after every change to the document, with its origin. */
export function onDocUpdate(
  doc: CardDoc,
  listener: (update: Uint8Array, origin: unknown) => void,
): () => void {
  doc.on("update", listener);
  return () => doc.off("update", listener);
}

/** True for an update that contains nothing (e.g. a diff when both sides agree). */
export function isEmptyUpdate(update: Uint8Array): boolean {
  return update.length <= 2 && update.every((byte) => byte === 0);
}

// ---- cursors -----------------------------------------------------------------
//
// A cursor is stored relative to the characters around it, not as a number,
// so it stays put when other people insert or delete text before it.

/** A cursor position in a text field, as JSON-friendly data for sending to others. */
export type TextCursor = unknown;

/**
 * A cursor at `index`, attached to the character before it (or the start of
 * the field). So when someone else types exactly where the cursor is, it
 * stays after the person's own text instead of jumping past theirs; two
 * people typing at the same spot each keep their words together.
 */
export function cursorAt(doc: CardDoc, field: CardTextField, index: number): TextCursor {
  return Y.relativePositionToJSON(
    Y.createRelativePositionFromTypeIndex(doc.getText(field), index, -1),
  );
}

/** Where a cursor is now, or null if it doesn't belong to this field. */
export function cursorIndex(doc: CardDoc, field: CardTextField, cursor: TextCursor): number | null {
  try {
    const absolute = Y.createAbsolutePositionFromRelativePosition(
      Y.createRelativePositionFromJSON(cursor),
      doc,
    );
    return absolute && absolute.type === doc.getText(field) ? absolute.index : null;
  } catch {
    return null; // malformed (it came from another client)
  }
}

// ---- undo --------------------------------------------------------------------

export interface TextUndo {
  undo(): void;
  redo(): void;
  destroy(): void;
}

/** Undo managers made by createUndo; their own changes count as local edits. */
const undoManagers = new WeakSet<object>();

/**
 * Whether a change came from undo/redo. Yjs labels those changes with the
 * undo manager itself rather than the origin of the typing being undone, so
 * code that sends local edits must check for this too, or undo would only
 * happen in this browser.
 */
export function isUndoOrigin(origin: unknown): boolean {
  return typeof origin === "object" && origin !== null && undoManagers.has(origin);
}

/**
 * Undo/redo for one field, covering only changes made with `origin` (this
 * user's typing), so undo never removes someone else's text.
 */
export function createUndo(doc: CardDoc, field: CardTextField, origin: unknown): TextUndo {
  const manager = new Y.UndoManager(doc.getText(field), { trackedOrigins: new Set([origin]) });
  undoManagers.add(manager);
  return {
    undo: () => void manager.undo(),
    redo: () => void manager.redo(),
    destroy: () => manager.destroy(),
  };
}

// ---- wire encoding -----------------------------------------------------------

// Available in browsers and in Node (16+); declared here because this package
// compiles without the DOM type library.
declare function btoa(data: string): string;
declare function atob(data: string): string;

export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

export function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
