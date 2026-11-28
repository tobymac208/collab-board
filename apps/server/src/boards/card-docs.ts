import { sql } from "kysely";
import {
  LIMITS,
  MAX_CARD_DOC_BYTES,
  applyUpdate,
  encodeState,
  loadCardDoc,
  readText,
  seedUpdate,
  type BoardChangeEvent,
  type CardDoc,
} from "@collab/shared";
import type { DB } from "../db/schema.ts";
import { CARD_FIELDS, StoreError, findCard, requireMember, toCard } from "./store.ts";

/**
 * Card text documents (phase 5): one CRDT document per card, holding its
 * title and description.
 *
 * - Documents are created on first use, seeded from the card's current
 *   plain text with `seedUpdate`, which is deterministic, so a browser that
 *   seeded the same card offline produces the identical edit.
 * - Updates are merged under a row lock on the document, so two writers
 *   can't both read the old state and lose one another's edits.
 * - The plain-text copy on `cards` is refreshed by `saveCardText`, shortly
 *   after edits stop, as an ordinary board change (revision, log, broadcast).
 *   Until then the document is marked dirty, which survives a restart.
 *
 * Lock order matches board writes (board, then document) wherever both are
 * taken, so the two can't deadlock.
 */

/** The board a card belongs to, if `userId` may see it and it matches `boardId`. */
async function requireCardOnBoard(db: DB, userId: string, boardId: string, cardId: string) {
  const card = await findCard(db, cardId);
  if (card.board_id !== boardId) throw new StoreError("not_found", "card not found");
  await requireMember(db, userId, boardId);
  return card;
}

/** Loads a card's document for update, creating (seeding) it if it doesn't exist yet. */
async function lockDoc(trx: DB, cardId: string): Promise<CardDoc | null> {
  const existing = await trx
    .selectFrom("card_docs")
    .select("state")
    .where("card_id", "=", cardId)
    .forUpdate()
    .executeTakeFirst();
  if (existing) return loadCardDoc(existing.state);

  const card = await trx
    .selectFrom("cards")
    .select(["board_id", "title", "description"])
    .where("id", "=", cardId)
    .executeTakeFirst();
  if (!card) return null; // deleted meanwhile
  const seed = seedUpdate(card.title, card.description);
  // Two first opens at once: one insert wins, both then lock the same row.
  await trx
    .insertInto("card_docs")
    .values({ card_id: cardId, board_id: card.board_id, state: Buffer.from(seed) })
    .onConflict((oc) => oc.column("card_id").doNothing())
    .execute();
  const row = await trx
    .selectFrom("card_docs")
    .select("state")
    .where("card_id", "=", cardId)
    .forUpdate()
    .executeTakeFirstOrThrow();
  return loadCardDoc(row.state);
}

/** A card's text document, for answering card_doc_open. */
export async function openCardDoc(
  db: DB,
  userId: string,
  boardId: string,
  cardId: string,
): Promise<CardDoc> {
  await requireCardOnBoard(db, userId, boardId, cardId);
  const doc = await db.transaction().execute((trx) => lockDoc(trx, cardId));
  if (!doc) throw new StoreError("not_found", "card not found");
  return doc;
}

/**
 * Merges an update into a card's document. Returns false if it changed
 * nothing (a resend or an echo), in which case there's nothing to pass on.
 */
export async function applyCardDocUpdate(
  db: DB,
  userId: string,
  boardId: string,
  cardId: string,
  update: Uint8Array,
): Promise<boolean> {
  await requireCardOnBoard(db, userId, boardId, cardId);
  return db.transaction().execute(async (trx) => {
    const doc = await lockDoc(trx, cardId);
    if (!doc) throw new StoreError("not_found", "card not found");
    let changed: boolean;
    try {
      changed = applyUpdate(doc, update);
    } catch {
      throw new StoreError("conflict", "that card text update couldn't be read");
    }
    if (!changed) return false;
    const state = encodeState(doc);
    if (state.length > MAX_CARD_DOC_BYTES) {
      throw new StoreError("conflict", "this card's text is too long to save");
    }
    await trx
      .updateTable("card_docs")
      .set({ state: Buffer.from(state), dirty: true, updated_at: new Date() })
      .where("card_id", "=", cardId)
      .execute();
    return true;
  });
}

/**
 * Copies a dirty document's text onto the card as a board change, and
 * returns that change for broadcasting. Null if there was nothing to do
 * (already saved, or the card is gone).
 *
 * The copy is clipped to the usual limits; the document itself may briefly
 * hold more (limits are enforced as people type).
 */
export async function saveCardText(db: DB, cardId: string): Promise<BoardChangeEvent | null> {
  const target = await db
    .selectFrom("card_docs")
    .select("board_id")
    .where("card_id", "=", cardId)
    .where("dirty", "=", true)
    .executeTakeFirst();
  if (!target) return null;
  const boardId = target.board_id;

  return db.transaction().execute(async (trx) => {
    // Board first, then document: the same order as board writes.
    await trx.selectFrom("boards").select("id").where("id", "=", boardId).forUpdate().execute();
    const row = await trx
      .selectFrom("card_docs")
      .select("state")
      .where("card_id", "=", cardId)
      .where("dirty", "=", true)
      .forUpdate()
      .executeTakeFirst();
    if (!row) return null; // saved meanwhile, or deleted
    const doc = loadCardDoc(row.state);
    const card = await trx
      .updateTable("cards")
      .set({
        title: readText(doc, "title").slice(0, LIMITS.cardTitle),
        description: readText(doc, "description").slice(0, LIMITS.cardDescription),
        version: sql<number>`version + 1`,
        updated_at: new Date(),
      })
      .where("id", "=", cardId)
      .where("board_id", "=", boardId)
      .returning(CARD_FIELDS)
      .executeTakeFirst();
    if (!card) return null;
    const { revision } = await trx
      .updateTable("boards")
      .set({ revision: sql<number>`revision + 1`, updated_at: new Date() })
      .where("id", "=", boardId)
      .returning("revision")
      .executeTakeFirstOrThrow();
    const event: BoardChangeEvent = { type: "card_upserted", card: toCard(card), revision };
    await trx
      .insertInto("board_changes")
      .values({ board_id: boardId, revision, event: JSON.stringify(event) })
      .execute();
    await trx
      .updateTable("card_docs")
      .set({ dirty: false })
      .where("card_id", "=", cardId)
      .execute();
    return event;
  });
}

/** Cards whose plain-text copy is behind their document (e.g. after a restart). */
export async function dirtyCardIds(db: DB): Promise<string[]> {
  const rows = await db
    .selectFrom("card_docs")
    .select("card_id")
    .where("dirty", "=", true)
    .execute();
  return rows.map((r) => r.card_id);
}
