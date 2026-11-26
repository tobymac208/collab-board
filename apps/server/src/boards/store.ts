import { generateKeyBetween, generateNKeysBetween } from "fractional-indexing";
import type { BoardMember, BoardSummary, Card, Column } from "@collab/shared";
import type { DB } from "../db/schema.ts";

/**
 * Board persistence and authorization. Every function takes the acting user
 * and checks their membership before touching data, so callers can't forget.
 *
 * Ordering: columns and cards carry fractional index keys. A move computes a
 * key between the neighbours at the target index, so only the moved row is
 * written. Concurrent moves into the same list are serialised with a row lock
 * on the parent (board for columns, column for cards) so two writers can't
 * pick the same key. Phase 3 revisits ordering under concurrent edits.
 */

export class StoreError extends Error {
  constructor(
    readonly code: "not_found" | "forbidden" | "conflict",
    message: string,
  ) {
    super(message);
  }
}

const DEFAULT_COLUMNS = ["To do", "In progress", "Done"];

/** A key that sorts at `index` in an already-sorted list of keys. */
export function positionAt(sorted: readonly string[], index: number): string {
  const i = Math.min(index, sorted.length);
  return generateKeyBetween(sorted[i - 1] ?? null, sorted[i] ?? null);
}

// ---- row mappers ---------------------------------------------------------

type ColumnRow = { id: string; board_id: string; name: string; position: string };
type CardRow = ColumnRow & { column_id: string; title: string; description: string };

const toColumn = (r: ColumnRow): Column => ({
  id: r.id,
  boardId: r.board_id,
  name: r.name,
  position: r.position,
});

const toCard = (r: Omit<CardRow, "name">): Card => ({
  id: r.id,
  boardId: r.board_id,
  columnId: r.column_id,
  title: r.title,
  description: r.description,
  position: r.position,
});

const COLUMN_FIELDS = ["id", "board_id", "name", "position"] as const;
const CARD_FIELDS = ["id", "board_id", "column_id", "title", "description", "position"] as const;

// ---- access checks -------------------------------------------------------

/**
 * Returns the board as seen by `userId`, or throws. Non-members get
 * `not_found` rather than `forbidden`, so board ids can't be probed.
 * With `lock`, the board row stays locked until the transaction ends.
 */
async function requireMember(
  db: DB,
  userId: string,
  boardId: string,
  opts: { owner?: boolean; lock?: boolean } = {},
): Promise<BoardSummary> {
  let query = db
    .selectFrom("boards")
    .innerJoin("board_members", "board_members.board_id", "boards.id")
    .select(["boards.id", "boards.name", "board_members.role"])
    .where("boards.id", "=", boardId)
    .where("board_members.user_id", "=", userId);
  if (opts.lock) query = query.forUpdate("boards");
  const row = await query.executeTakeFirst();
  if (!row) throw new StoreError("not_found", "board not found");
  if (opts.owner && row.role !== "owner") {
    throw new StoreError("forbidden", "only the board owner can do that");
  }
  return row;
}

async function findColumn(db: DB, columnId: string, opts: { lock?: boolean } = {}) {
  let query = db.selectFrom("board_columns").select(COLUMN_FIELDS).where("id", "=", columnId);
  if (opts.lock) query = query.forUpdate();
  const row = await query.executeTakeFirst();
  if (!row) throw new StoreError("not_found", "column not found");
  return row;
}

async function findCard(db: DB, cardId: string) {
  const row = await db
    .selectFrom("cards")
    .select(CARD_FIELDS)
    .where("id", "=", cardId)
    .executeTakeFirst();
  if (!row) throw new StoreError("not_found", "card not found");
  return row;
}

/** Column lookup that also hides columns on boards the user can't see. */
async function requireColumn(db: DB, userId: string, columnId: string) {
  const column = await findColumn(db, columnId);
  await requireMember(db, userId, column.board_id);
  return column;
}

async function requireCard(db: DB, userId: string, cardId: string) {
  const card = await findCard(db, cardId);
  await requireMember(db, userId, card.board_id);
  return card;
}

// ---- boards --------------------------------------------------------------

export async function listBoards(db: DB, userId: string): Promise<BoardSummary[]> {
  return db
    .selectFrom("boards")
    .innerJoin("board_members", "board_members.board_id", "boards.id")
    .select(["boards.id", "boards.name", "board_members.role"])
    .where("board_members.user_id", "=", userId)
    .orderBy("boards.created_at")
    .orderBy("boards.id")
    .execute();
}

export async function createBoard(db: DB, userId: string, name: string): Promise<BoardSummary> {
  return db.transaction().execute(async (trx) => {
    const board = await trx
      .insertInto("boards")
      .values({ name, created_by: userId })
      .returning(["id", "name"])
      .executeTakeFirstOrThrow();
    await trx
      .insertInto("board_members")
      .values({ board_id: board.id, user_id: userId, role: "owner" })
      .execute();
    const positions = generateNKeysBetween(null, null, DEFAULT_COLUMNS.length);
    await trx
      .insertInto("board_columns")
      .values(
        DEFAULT_COLUMNS.map((columnName, i) => ({
          board_id: board.id,
          name: columnName,
          position: positions[i]!,
        })),
      )
      .execute();
    return { ...board, role: "owner" as const };
  });
}

export async function renameBoard(
  db: DB,
  userId: string,
  boardId: string,
  name: string,
): Promise<BoardSummary> {
  const board = await requireMember(db, userId, boardId, { owner: true });
  await db
    .updateTable("boards")
    .set({ name, updated_at: new Date() })
    .where("id", "=", boardId)
    .execute();
  return { ...board, name };
}

export async function deleteBoard(db: DB, userId: string, boardId: string): Promise<void> {
  await requireMember(db, userId, boardId, { owner: true });
  await db.deleteFrom("boards").where("id", "=", boardId).execute();
}

export interface BoardSnapshot {
  board: BoardSummary;
  members: BoardMember[];
  columns: Column[];
  cards: Card[];
}

export async function getBoardSnapshot(
  db: DB,
  userId: string,
  boardId: string,
): Promise<BoardSnapshot> {
  // One transaction so the columns and cards come from the same moment.
  return db
    .transaction()
    .setIsolationLevel("repeatable read")
    .execute(async (trx) => {
      const board = await requireMember(trx, userId, boardId);
      const [members, columns, cards] = await Promise.all([
        trx
          .selectFrom("board_members")
          .innerJoin("users", "users.id", "board_members.user_id")
          .select([
            "users.id as userId",
            "users.email",
            "users.display_name as displayName",
            "board_members.role",
          ])
          .where("board_members.board_id", "=", boardId)
          .orderBy("board_members.created_at")
          .execute(),
        trx
          .selectFrom("board_columns")
          .select(COLUMN_FIELDS)
          .where("board_id", "=", boardId)
          .orderBy("position")
          .execute(),
        trx
          .selectFrom("cards")
          .select(CARD_FIELDS)
          .where("board_id", "=", boardId)
          .orderBy("column_id")
          .orderBy("position")
          .execute(),
      ]);
      return { board, members, columns: columns.map(toColumn), cards: cards.map(toCard) };
    });
}

export async function addMember(
  db: DB,
  userId: string,
  boardId: string,
  email: string,
): Promise<BoardMember> {
  await requireMember(db, userId, boardId, { owner: true });
  const user = await db
    .selectFrom("users")
    .select(["id", "email", "display_name"])
    .where("email", "=", email.trim().toLowerCase())
    .executeTakeFirst();
  if (!user) throw new StoreError("not_found", "no account uses that email");
  const inserted = await db
    .insertInto("board_members")
    .values({ board_id: boardId, user_id: user.id, role: "editor" })
    .onConflict((oc) => oc.columns(["board_id", "user_id"]).doNothing())
    .executeTakeFirst();
  if (inserted.numInsertedOrUpdatedRows === 0n) {
    throw new StoreError("conflict", "that person is already on this board");
  }
  return { userId: user.id, email: user.email, displayName: user.display_name, role: "editor" };
}

// ---- columns -------------------------------------------------------------

export async function createColumn(
  db: DB,
  userId: string,
  boardId: string,
  name: string,
): Promise<Column> {
  return db.transaction().execute(async (trx) => {
    await requireMember(trx, userId, boardId, { lock: true });
    const last = await trx
      .selectFrom("board_columns")
      .select("position")
      .where("board_id", "=", boardId)
      .orderBy("position", "desc")
      .limit(1)
      .executeTakeFirst();
    const row = await trx
      .insertInto("board_columns")
      .values({
        board_id: boardId,
        name,
        position: generateKeyBetween(last?.position ?? null, null),
      })
      .returning(COLUMN_FIELDS)
      .executeTakeFirstOrThrow();
    return toColumn(row);
  });
}

export async function renameColumn(
  db: DB,
  userId: string,
  columnId: string,
  name: string,
): Promise<Column> {
  const column = await requireColumn(db, userId, columnId);
  await db.updateTable("board_columns").set({ name }).where("id", "=", columnId).execute();
  return toColumn({ ...column, name });
}

export async function moveColumn(
  db: DB,
  userId: string,
  columnId: string,
  toIndex: number,
): Promise<Column> {
  return db.transaction().execute(async (trx) => {
    const column = await findColumn(trx, columnId);
    await requireMember(trx, userId, column.board_id, { lock: true });
    const others = await trx
      .selectFrom("board_columns")
      .select("position")
      .where("board_id", "=", column.board_id)
      .where("id", "!=", columnId)
      .orderBy("position")
      .execute();
    const position = positionAt(
      others.map((c) => c.position),
      toIndex,
    );
    await trx.updateTable("board_columns").set({ position }).where("id", "=", columnId).execute();
    return toColumn({ ...column, position });
  });
}

export async function deleteColumn(db: DB, userId: string, columnId: string): Promise<Column> {
  const column = await requireColumn(db, userId, columnId);
  await db.deleteFrom("board_columns").where("id", "=", columnId).execute();
  return toColumn(column);
}

// ---- cards ---------------------------------------------------------------

export async function createCard(
  db: DB,
  userId: string,
  columnId: string,
  title: string,
): Promise<Card> {
  return db.transaction().execute(async (trx) => {
    const column = await findColumn(trx, columnId, { lock: true });
    await requireMember(trx, userId, column.board_id);
    const last = await trx
      .selectFrom("cards")
      .select("position")
      .where("column_id", "=", columnId)
      .orderBy("position", "desc")
      .limit(1)
      .executeTakeFirst();
    const row = await trx
      .insertInto("cards")
      .values({
        board_id: column.board_id,
        column_id: columnId,
        title,
        position: generateKeyBetween(last?.position ?? null, null),
      })
      .returning(CARD_FIELDS)
      .executeTakeFirstOrThrow();
    return toCard(row);
  });
}

export async function updateCard(
  db: DB,
  userId: string,
  cardId: string,
  changes: { title?: string | undefined; description?: string | undefined },
): Promise<Card> {
  const card = await requireCard(db, userId, cardId);
  const set = {
    ...(changes.title === undefined ? {} : { title: changes.title }),
    ...(changes.description === undefined ? {} : { description: changes.description }),
  };
  if (Object.keys(set).length === 0) return toCard(card);
  const row = await db
    .updateTable("cards")
    .set({ ...set, updated_at: new Date() })
    .where("id", "=", cardId)
    .returning(CARD_FIELDS)
    .executeTakeFirst();
  if (!row) throw new StoreError("not_found", "card not found");
  return toCard(row);
}

export async function moveCard(
  db: DB,
  userId: string,
  cardId: string,
  toColumnId: string,
  toIndex: number,
): Promise<Card> {
  return db.transaction().execute(async (trx) => {
    const card = await findCard(trx, cardId);
    await requireMember(trx, userId, card.board_id);
    const target = await findColumn(trx, toColumnId, { lock: true });
    if (target.board_id !== card.board_id) throw new StoreError("not_found", "column not found");
    const others = await trx
      .selectFrom("cards")
      .select("position")
      .where("column_id", "=", toColumnId)
      .where("id", "!=", cardId)
      .orderBy("position")
      .execute();
    const position = positionAt(
      others.map((c) => c.position),
      toIndex,
    );
    const row = await trx
      .updateTable("cards")
      .set({ column_id: toColumnId, position, updated_at: new Date() })
      .where("id", "=", cardId)
      .returning(CARD_FIELDS)
      .executeTakeFirst();
    if (!row) throw new StoreError("not_found", "card not found"); // deleted meanwhile
    return toCard(row);
  });
}

export async function deleteCard(db: DB, userId: string, cardId: string): Promise<Card> {
  const card = await requireCard(db, userId, cardId);
  await db.deleteFrom("cards").where("id", "=", cardId).execute();
  return toCard(card);
}
