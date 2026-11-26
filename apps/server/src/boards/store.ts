import { sql } from "kysely";
import {
  initialPositions,
  positionAtEnd,
  positionBetweenNeighbours,
  type BoardMember,
  type BoardRole,
  type BoardSummary,
  type Card,
  type CardField,
  type Column,
} from "@collab/shared";
import type { DB } from "../db/schema.ts";

/**
 * Board persistence and authorization. Every function takes the acting user
 * and checks their membership before touching data, so callers can't forget.
 *
 * Writes: every change to a board goes through `writeBoard`, which locks the
 * board row, applies the change and increments `boards.revision` in one
 * transaction. The lock queues concurrent writes to the same board one at a
 * time, so revisions are gap-free and follow commit order, and two writers
 * can never pick the same position key.
 *
 * Ordering: columns and cards carry fractional index keys, so a move writes
 * only the moved row. Moves name the neighbours the user dropped the item
 * between; see `positionBetweenNeighbours` for how that survives concurrent
 * edits.
 *
 * Conflicts: card fields remember the card version at which they last
 * changed. An edit based on an older version is rejected only for fields
 * that changed since (and only if the values differ), so concurrent edits to
 * different fields merge.
 */

export class StoreError extends Error {
  constructor(
    readonly code: "not_found" | "forbidden" | "conflict",
    message: string,
    /** For edit conflicts: the card fields someone else changed meanwhile. */
    readonly conflictingFields?: CardField[],
  ) {
    super(message);
  }
}

/** The result of a write, plus the board revision it produced. */
export interface Revisioned<T> {
  value: T;
  boardId: string;
  revision: number;
}

const DEFAULT_COLUMNS = ["To do", "In progress", "Done"];

// ---- row mappers ---------------------------------------------------------

type ColumnRow = { id: string; board_id: string; name: string; position: string };
type CardRow = Omit<ColumnRow, "name"> & {
  column_id: string;
  title: string;
  description: string;
  version: number;
};

const toColumn = (r: ColumnRow): Column => ({
  id: r.id,
  boardId: r.board_id,
  name: r.name,
  position: r.position,
});

const toCard = (r: CardRow): Card => ({
  id: r.id,
  boardId: r.board_id,
  columnId: r.column_id,
  title: r.title,
  description: r.description,
  position: r.position,
  version: r.version,
});

const COLUMN_FIELDS = ["id", "board_id", "name", "position"] as const;
const CARD_FIELDS = [
  "id",
  "board_id",
  "column_id",
  "title",
  "description",
  "position",
  "version",
] as const;

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
): Promise<BoardSummary & { revision: number }> {
  let query = db
    .selectFrom("boards")
    .innerJoin("board_members", "board_members.board_id", "boards.id")
    .select(["boards.id", "boards.name", "boards.revision", "board_members.role"])
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

/** Throws unless `userId` is a member of the board. */
export async function requireAccess(db: DB, userId: string, boardId: string): Promise<void> {
  await requireMember(db, userId, boardId);
}

async function findColumn(db: DB, columnId: string) {
  const row = await db
    .selectFrom("board_columns")
    .select(COLUMN_FIELDS)
    .where("id", "=", columnId)
    .executeTakeFirst();
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

/**
 * Runs `change` as a write to one board: checks membership, locks the board,
 * and bumps its revision in the same transaction.
 */
async function writeBoard<T>(
  db: DB,
  userId: string,
  boardId: string,
  opts: { owner?: boolean },
  change: (trx: DB, board: BoardSummary) => Promise<T>,
): Promise<Revisioned<T>> {
  return db.transaction().execute(async (trx) => {
    const { revision: _before, ...board } = await requireMember(trx, userId, boardId, {
      ...opts,
      lock: true,
    });
    const value = await change(trx, board);
    const { revision } = await trx
      .updateTable("boards")
      .set({ revision: sql<number>`revision + 1`, updated_at: new Date() })
      .where("id", "=", boardId)
      .returning("revision")
      .executeTakeFirstOrThrow();
    return { value, boardId, revision };
  });
}

/**
 * The board a column or card belongs to. Read before taking the board lock;
 * the write re-reads the row under the lock in case it changed meanwhile.
 */
async function boardOfColumn(db: DB, columnId: string): Promise<string> {
  return (await findColumn(db, columnId)).board_id;
}

async function boardOfCard(db: DB, cardId: string): Promise<string> {
  return (await findCard(db, cardId)).board_id;
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

/** Every member of a board and their role, for fanning out board-list changes. */
export async function listMemberRoles(
  db: DB,
  boardId: string,
): Promise<{ userId: string; role: BoardRole }[]> {
  return db
    .selectFrom("board_members")
    .select(["user_id as userId", "role"])
    .where("board_id", "=", boardId)
    .execute();
}

export async function createBoard(
  db: DB,
  userId: string,
  name: string,
): Promise<Revisioned<BoardSummary>> {
  return db.transaction().execute(async (trx) => {
    const board = await trx
      .insertInto("boards")
      .values({ name, created_by: userId })
      .returning(["id", "name", "revision"])
      .executeTakeFirstOrThrow();
    await trx
      .insertInto("board_members")
      .values({ board_id: board.id, user_id: userId, role: "owner" })
      .execute();
    const positions = initialPositions(DEFAULT_COLUMNS.length);
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
    return {
      value: { id: board.id, name: board.name, role: "owner" as const },
      boardId: board.id,
      revision: board.revision,
    };
  });
}

/**
 * Renames the board. Also returns its members and their roles, read in the
 * same transaction, so the caller can tell each of them (with their own role)
 * without a second query that could fail after the rename committed.
 */
export async function renameBoard(
  db: DB,
  userId: string,
  boardId: string,
  name: string,
): Promise<Revisioned<{ name: string; members: { userId: string; role: BoardRole }[] }>> {
  return writeBoard(db, userId, boardId, { owner: true }, async (trx) => {
    await trx.updateTable("boards").set({ name }).where("id", "=", boardId).execute();
    return { name, members: await listMemberRoles(trx, boardId) };
  });
}

/** Deletes the board and returns who was on it, so they can be told. */
export async function deleteBoard(db: DB, userId: string, boardId: string): Promise<string[]> {
  return db.transaction().execute(async (trx) => {
    await requireMember(trx, userId, boardId, { owner: true, lock: true });
    const members = await listMemberRoles(trx, boardId);
    await trx.deleteFrom("boards").where("id", "=", boardId).execute();
    return members.map((m) => m.userId);
  });
}

export interface BoardSnapshot {
  board: BoardSummary;
  revision: number;
  members: BoardMember[];
  columns: Column[];
  cards: Card[];
}

export async function getBoardSnapshot(
  db: DB,
  userId: string,
  boardId: string,
): Promise<BoardSnapshot> {
  // One transaction so the board, its revision and its contents all come
  // from the same moment.
  return db
    .transaction()
    .setIsolationLevel("repeatable read")
    .execute(async (trx) => {
      const { revision, ...board } = await requireMember(trx, userId, boardId);
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
      return {
        board,
        revision,
        members,
        columns: columns.map(toColumn),
        cards: cards.map(toCard),
      };
    });
}

export async function addMember(
  db: DB,
  userId: string,
  boardId: string,
  email: string,
): Promise<Revisioned<{ member: BoardMember; boardName: string }>> {
  return writeBoard(db, userId, boardId, { owner: true }, async (trx, board) => {
    const user = await trx
      .selectFrom("users")
      .select(["id", "email", "display_name"])
      .where("email", "=", email.trim().toLowerCase())
      .executeTakeFirst();
    if (!user) throw new StoreError("not_found", "no account uses that email");
    const inserted = await trx
      .insertInto("board_members")
      .values({ board_id: boardId, user_id: user.id, role: "editor" })
      .onConflict((oc) => oc.columns(["board_id", "user_id"]).doNothing())
      .executeTakeFirst();
    if (inserted.numInsertedOrUpdatedRows === 0n) {
      throw new StoreError("conflict", "that person is already on this board");
    }
    const member: BoardMember = {
      userId: user.id,
      email: user.email,
      displayName: user.display_name,
      role: "editor",
    };
    return { member, boardName: board.name };
  });
}

// ---- columns -------------------------------------------------------------

export async function createColumn(
  db: DB,
  userId: string,
  boardId: string,
  name: string,
  id?: string,
): Promise<Revisioned<Column>> {
  return writeBoard(db, userId, boardId, {}, async (trx) => {
    const siblings = await trx
      .selectFrom("board_columns")
      .select(["id", "position"])
      .where("board_id", "=", boardId)
      .orderBy("position")
      .execute();
    const row = await trx
      .insertInto("board_columns")
      .values({ ...(id ? { id } : {}), board_id: boardId, name, position: positionAtEnd(siblings) })
      .onConflict((oc) => oc.column("id").doNothing())
      .returning(COLUMN_FIELDS)
      .executeTakeFirst();
    if (!row) throw new StoreError("conflict", "that id is already in use");
    return toColumn(row);
  });
}

export async function renameColumn(
  db: DB,
  userId: string,
  columnId: string,
  name: string,
): Promise<Revisioned<Column>> {
  const boardId = await boardOfColumn(db, columnId);
  return writeBoard(db, userId, boardId, {}, async (trx) => {
    const row = await trx
      .updateTable("board_columns")
      .set({ name })
      .where("id", "=", columnId)
      .returning(COLUMN_FIELDS)
      .executeTakeFirst();
    if (!row) throw new StoreError("not_found", "column not found");
    return toColumn(row);
  });
}

export async function moveColumn(
  db: DB,
  userId: string,
  columnId: string,
  afterId: string | null,
  beforeId: string | null,
): Promise<Revisioned<Column>> {
  const boardId = await boardOfColumn(db, columnId);
  return writeBoard(db, userId, boardId, {}, async (trx) => {
    const siblings = await trx
      .selectFrom("board_columns")
      .select(["id", "position"])
      .where("board_id", "=", boardId)
      .where("id", "!=", columnId)
      .orderBy("position")
      .execute();
    const row = await trx
      .updateTable("board_columns")
      .set({ position: positionBetweenNeighbours(siblings, afterId, beforeId) })
      .where("id", "=", columnId)
      .returning(COLUMN_FIELDS)
      .executeTakeFirst();
    if (!row) throw new StoreError("not_found", "column not found");
    return toColumn(row);
  });
}

export async function deleteColumn(
  db: DB,
  userId: string,
  columnId: string,
): Promise<Revisioned<Column>> {
  const boardId = await boardOfColumn(db, columnId);
  return writeBoard(db, userId, boardId, {}, async (trx) => {
    const row = await trx
      .deleteFrom("board_columns")
      .where("id", "=", columnId)
      .returning(COLUMN_FIELDS)
      .executeTakeFirst();
    if (!row) throw new StoreError("not_found", "column not found");
    return toColumn(row);
  });
}

// ---- cards ---------------------------------------------------------------

export async function createCard(
  db: DB,
  userId: string,
  columnId: string,
  title: string,
  id?: string,
): Promise<Revisioned<Card>> {
  const boardId = await boardOfColumn(db, columnId);
  return writeBoard(db, userId, boardId, {}, async (trx) => {
    await findColumn(trx, columnId); // still there?
    const siblings = await trx
      .selectFrom("cards")
      .select(["id", "position"])
      .where("column_id", "=", columnId)
      .orderBy("position")
      .execute();
    const row = await trx
      .insertInto("cards")
      .values({
        ...(id ? { id } : {}),
        board_id: boardId,
        column_id: columnId,
        title,
        position: positionAtEnd(siblings),
      })
      .onConflict((oc) => oc.column("id").doNothing())
      .returning(CARD_FIELDS)
      .executeTakeFirst();
    if (!row) throw new StoreError("conflict", "that id is already in use");
    return toCard(row);
  });
}

export type CardEdit = Partial<Record<CardField, { value: string; baseVersion: number }>>;

export async function updateCard(
  db: DB,
  userId: string,
  cardId: string,
  edit: CardEdit,
): Promise<Revisioned<Card>> {
  const boardId = await boardOfCard(db, cardId);
  return writeBoard(db, userId, boardId, {}, async (trx) => {
    // The board lock taken by writeBoard keeps this row stable until commit.
    const current = await trx
      .selectFrom("cards")
      .select([...CARD_FIELDS, "title_version", "description_version"])
      .where("id", "=", cardId)
      .executeTakeFirst();
    if (!current) throw new StoreError("not_found", "card not found");
    const fieldVersion = { title: current.title_version, description: current.description_version };

    const changed: CardField[] = [];
    const conflicts: CardField[] = [];
    for (const field of ["title", "description"] as const) {
      const change = edit[field];
      if (!change || change.value === current[field]) continue; // nothing to do
      if (fieldVersion[field] > change.baseVersion) conflicts.push(field);
      else changed.push(field);
    }
    if (conflicts.length > 0) {
      throw new StoreError(
        "conflict",
        "someone else changed this card while you were editing",
        conflicts,
      );
    }
    if (changed.length === 0) return toCard(current);

    const version = current.version + 1;
    const row = await trx
      .updateTable("cards")
      .set({
        version,
        updated_at: new Date(),
        ...(changed.includes("title") ? { title: edit.title!.value, title_version: version } : {}),
        ...(changed.includes("description")
          ? { description: edit.description!.value, description_version: version }
          : {}),
      })
      .where("id", "=", cardId)
      .returning(CARD_FIELDS)
      .executeTakeFirstOrThrow();
    return toCard(row);
  });
}

export async function moveCard(
  db: DB,
  userId: string,
  cardId: string,
  toColumnId: string,
  afterId: string | null,
  beforeId: string | null,
): Promise<Revisioned<Card>> {
  const boardId = await boardOfCard(db, cardId);
  return writeBoard(db, userId, boardId, {}, async (trx) => {
    const target = await findColumn(trx, toColumnId);
    if (target.board_id !== boardId) throw new StoreError("not_found", "column not found");
    const siblings = await trx
      .selectFrom("cards")
      .select(["id", "position"])
      .where("column_id", "=", toColumnId)
      .where("id", "!=", cardId)
      .orderBy("position")
      .execute();
    const row = await trx
      .updateTable("cards")
      .set({
        column_id: toColumnId,
        position: positionBetweenNeighbours(siblings, afterId, beforeId),
        version: sql<number>`version + 1`,
        updated_at: new Date(),
      })
      .where("id", "=", cardId)
      .returning(CARD_FIELDS)
      .executeTakeFirst();
    if (!row) throw new StoreError("not_found", "card not found"); // deleted meanwhile
    return toCard(row);
  });
}

export async function deleteCard(
  db: DB,
  userId: string,
  cardId: string,
): Promise<Revisioned<Card>> {
  const boardId = await boardOfCard(db, cardId);
  return writeBoard(db, userId, boardId, {}, async (trx) => {
    const row = await trx
      .deleteFrom("cards")
      .where("id", "=", cardId)
      .returning(CARD_FIELDS)
      .executeTakeFirst();
    if (!row) throw new StoreError("not_found", "card not found");
    return toCard(row);
  });
}
