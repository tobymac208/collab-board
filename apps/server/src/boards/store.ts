import { sql } from "kysely";
import {
  initialPositions,
  positionAtEnd,
  positionBetweenNeighbours,
  type BoardChangeEvent,
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
 * board row, applies the change, increments `boards.revision`, and logs the
 * resulting event in one transaction. The lock queues concurrent writes to
 * the same board one at a time, so revisions are gap-free and follow commit
 * order, and two writers can never pick the same position key. The log lets
 * reconnecting clients catch up; client changes carry an opId so a resent
 * change is applied only once.
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

// ---- writes --------------------------------------------------------------

/** Who is making a change, and (for client changes) the change's id. */
export interface Actor {
  userId: string;
  /** Set for client board changes; repeats are applied at most once. */
  opId?: string | undefined;
}

/** The outcome of a board write. */
export type BoardWrite<T> = {
  boardId: string;
  revision: number;
  /** The change as everyone sees it (also kept in the change log). */
  event: BoardChangeEvent;
} & (
  | { replayed: false; value: T }
  /** This opId was already applied: nothing changed, here's what it did then. */
  | { replayed: true; value?: undefined }
);

/** A previously applied op, with the event it produced. */
async function findApplied(db: DB, actor: Actor): Promise<BoardWrite<never> | null> {
  if (!actor.opId) return null;
  const row = await db
    .selectFrom("applied_ops")
    .innerJoin("board_changes", (join) =>
      join
        .onRef("board_changes.board_id", "=", "applied_ops.board_id")
        .onRef("board_changes.revision", "=", "applied_ops.revision"),
    )
    .select([
      "applied_ops.user_id",
      "applied_ops.board_id",
      "applied_ops.revision",
      "board_changes.event",
    ])
    .where("applied_ops.op_id", "=", actor.opId)
    .executeTakeFirst();
  if (!row) return null;
  if (row.user_id !== actor.userId) {
    throw new StoreError("conflict", "that change id belongs to someone else");
  }
  return { boardId: row.board_id, revision: row.revision, event: row.event, replayed: true };
}

/**
 * Runs `change` as a write to one board, in one transaction: checks
 * membership, locks the board, applies the change, bumps the revision, logs
 * the resulting event, and records the op as applied.
 *
 * `target` is the board id, or a function that finds it (e.g. from a card).
 * Replays are detected before resolving it, so resending "delete card" still
 * answers with the original result rather than "card not found".
 */
async function writeBoard<T>(
  db: DB,
  actor: Actor,
  target: string | (() => Promise<string>),
  opts: { owner?: boolean },
  change: (trx: DB, board: BoardSummary, boardId: string) => Promise<T>,
  toEvent: (value: T, revision: number, boardId: string) => BoardChangeEvent,
): Promise<BoardWrite<T>> {
  const earlier = await findApplied(db, actor);
  if (earlier) return earlier;

  let boardId: string;
  try {
    boardId = typeof target === "string" ? target : await target();
  } catch (err) {
    // A resent delete can race the original: by the time we look the card up,
    // the original has just deleted it. That's a replay, not "not found".
    if (err instanceof StoreError && err.code === "not_found") {
      const replay = await findApplied(db, actor);
      if (replay) return replay;
    }
    throw err;
  }

  try {
    return await applyWrite(db, actor, boardId, opts, change, toEvent);
  } catch (err) {
    // The same opId sent for two different boards at once: both got past the
    // checks (they lock different boards) and the loser's applied_ops insert
    // hit the key. Answer exactly as if it had arrived after the winner.
    if (isDuplicateOpId(err)) {
      const winner = await findApplied(db, actor);
      if (winner) return winner;
    }
    throw err;
  }
}

/** A unique-key violation on applied_ops, i.e. this opId was just recorded. */
function isDuplicateOpId(err: unknown): boolean {
  const e = err as { code?: string; constraint?: string } | null;
  return e?.code === "23505" && e.constraint === "applied_ops_pkey";
}

async function applyWrite<T>(
  db: DB,
  actor: Actor,
  boardId: string,
  opts: { owner?: boolean },
  change: (trx: DB, board: BoardSummary, boardId: string) => Promise<T>,
  toEvent: (value: T, revision: number, boardId: string) => BoardChangeEvent,
): Promise<BoardWrite<T>> {
  return db.transaction().execute(async (trx) => {
    const { revision: _before, ...board } = await requireMember(trx, actor.userId, boardId, {
      ...opts,
      lock: true,
    });
    // The same op sent twice at once: the second waits on the lock above.
    const raced = await findApplied(trx, actor);
    if (raced) return raced;

    const value = await change(trx, board, boardId);
    const { revision } = await trx
      .updateTable("boards")
      .set({ revision: sql<number>`revision + 1`, updated_at: new Date() })
      .where("id", "=", boardId)
      .returning("revision")
      .executeTakeFirstOrThrow();
    const event = toEvent(value, revision, boardId);
    await trx
      .insertInto("board_changes")
      .values({ board_id: boardId, revision, event: JSON.stringify(event) })
      .execute();
    if (actor.opId) {
      await trx
        .insertInto("applied_ops")
        .values({ op_id: actor.opId, user_id: actor.userId, board_id: boardId, revision })
        .execute();
    }
    return { boardId, revision, event, replayed: false, value };
  });
}

const boardOfColumn = (db: DB, columnId: string) => async () =>
  (await findColumn(db, columnId)).board_id;

const boardOfCard = (db: DB, cardId: string) => async () => (await findCard(db, cardId)).board_id;

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
): Promise<{ board: BoardSummary; revision: number }> {
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
      board: { id: board.id, name: board.name, role: "owner" as const },
      revision: board.revision,
    };
  });
}

/**
 * Renames the board. Also returns its members and their roles, read in the
 * same transaction, so the caller can tell each of them (with their own role)
 * without a second query that could fail after the rename committed.
 *
 * The logged event carries the owner's role; clients ignore `role` when
 * applying a rename to a board they have open.
 */
export async function renameBoard(
  db: DB,
  actor: Actor,
  boardId: string,
  name: string,
): Promise<BoardWrite<{ members: { userId: string; role: BoardRole }[] }>> {
  return writeBoard(
    db,
    actor,
    boardId,
    { owner: true },
    async (trx) => {
      await trx.updateTable("boards").set({ name }).where("id", "=", boardId).execute();
      return { members: await listMemberRoles(trx, boardId) };
    },
    (_value, revision) => ({
      type: "board_upserted",
      board: { id: boardId, name, role: "owner" },
      revision,
    }),
  );
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

/** Catching up a client further behind than this sends a snapshot instead. */
export const MAX_CATCH_UP = 500;

/**
 * Every change to a board after `sinceRevision`, in order, or null if the
 * log can't provide all of them (pruned, too many, or a client claiming a
 * revision the board never reached). Null means: send a snapshot.
 *
 * Access policy: a member sees history only from when they joined. Asking
 * for changes from before then gets null (a snapshot), which shows the board
 * as it is now, exactly what a new member's first load shows. Older titles
 * and descriptions in the log stay out of reach.
 *
 * Board renames are returned with the reader's own role, matching what the
 * live broadcast sends them (the log stores the owner's).
 */
export async function getChangesSince(
  db: DB,
  userId: string,
  boardId: string,
  sinceRevision: number,
): Promise<BoardChangeEvent[] | null> {
  return db
    .transaction()
    .setIsolationLevel("repeatable read")
    .execute(async (trx) => {
      const { revision, role } = await requireMember(trx, userId, boardId);
      const missing = revision - sinceRevision;
      if (missing < 0 || missing > MAX_CATCH_UP) return null;
      if (missing === 0) return [];
      const { created_at: joinedAt } = await trx
        .selectFrom("board_members")
        .select("created_at")
        .where("board_id", "=", boardId)
        .where("user_id", "=", userId)
        .executeTakeFirstOrThrow();
      const rows = await trx
        .selectFrom("board_changes")
        .select(["revision", "event", "created_at"])
        .where("board_id", "=", boardId)
        .where("revision", ">", sinceRevision)
        .where("revision", "<=", revision)
        .orderBy("revision")
        .execute();
      // Revisions are gap-free, so a complete answer has exactly one row each.
      if (rows.length !== missing || rows[0]?.revision !== sinceRevision + 1) return null;
      // Joining is itself logged (member_added) in the same transaction, so
      // its timestamp equals joinedAt and the member's own join is included.
      if (rows[0].created_at < joinedAt) return null;
      return rows.map(({ event }) =>
        event.type === "board_upserted" ? { ...event, board: { ...event.board, role } } : event,
      );
    });
}

/** Forgets change-log and applied-op entries older than `before`. */
export async function pruneHistory(db: DB, before: Date): Promise<void> {
  await db.deleteFrom("applied_ops").where("created_at", "<", before).execute();
  await db.deleteFrom("board_changes").where("created_at", "<", before).execute();
}

export async function addMember(
  db: DB,
  actor: Actor,
  boardId: string,
  email: string,
): Promise<BoardWrite<{ member: BoardMember; boardName: string }>> {
  return writeBoard(
    db,
    actor,
    boardId,
    { owner: true },
    async (trx, board) => {
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
    },
    ({ member }, revision) => ({ type: "member_added", boardId, member, revision }),
  );
}

// ---- columns -------------------------------------------------------------

const columnUpserted = (column: Column, revision: number): BoardChangeEvent => ({
  type: "column_upserted",
  column,
  revision,
});

export async function createColumn(
  db: DB,
  actor: Actor,
  boardId: string,
  name: string,
  id?: string,
): Promise<BoardWrite<Column>> {
  return writeBoard(
    db,
    actor,
    boardId,
    {},
    async (trx) => {
      const siblings = await trx
        .selectFrom("board_columns")
        .select(["id", "position"])
        .where("board_id", "=", boardId)
        .orderBy("position")
        .execute();
      const row = await trx
        .insertInto("board_columns")
        .values({
          ...(id ? { id } : {}),
          board_id: boardId,
          name,
          position: positionAtEnd(siblings),
        })
        .onConflict((oc) => oc.column("id").doNothing())
        .returning(COLUMN_FIELDS)
        .executeTakeFirst();
      if (!row) throw new StoreError("conflict", "that id is already in use");
      return toColumn(row);
    },
    columnUpserted,
  );
}

export async function renameColumn(
  db: DB,
  actor: Actor,
  columnId: string,
  name: string,
): Promise<BoardWrite<Column>> {
  return writeBoard(
    db,
    actor,
    boardOfColumn(db, columnId),
    {},
    async (trx, _board, boardId) => {
      const row = await trx
        .updateTable("board_columns")
        .set({ name })
        .where("id", "=", columnId)
        .where("board_id", "=", boardId)
        .returning(COLUMN_FIELDS)
        .executeTakeFirst();
      if (!row) throw new StoreError("not_found", "column not found");
      return toColumn(row);
    },
    columnUpserted,
  );
}

export async function moveColumn(
  db: DB,
  actor: Actor,
  columnId: string,
  afterId: string | null,
  beforeId: string | null,
): Promise<BoardWrite<Column>> {
  return writeBoard(
    db,
    actor,
    boardOfColumn(db, columnId),
    {},
    async (trx, _board, boardId) => {
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
        .where("board_id", "=", boardId)
        .returning(COLUMN_FIELDS)
        .executeTakeFirst();
      if (!row) throw new StoreError("not_found", "column not found");
      return toColumn(row);
    },
    columnUpserted,
  );
}

export async function deleteColumn(
  db: DB,
  actor: Actor,
  columnId: string,
): Promise<BoardWrite<Column>> {
  return writeBoard(
    db,
    actor,
    boardOfColumn(db, columnId),
    {},
    async (trx, _board, boardId) => {
      const row = await trx
        .deleteFrom("board_columns")
        .where("id", "=", columnId)
        .where("board_id", "=", boardId)
        .returning(COLUMN_FIELDS)
        .executeTakeFirst();
      if (!row) throw new StoreError("not_found", "column not found");
      return toColumn(row);
    },
    (column, revision, boardId) => ({
      type: "column_deleted",
      boardId,
      columnId: column.id,
      revision,
    }),
  );
}

// ---- cards ---------------------------------------------------------------

const cardUpserted = (card: Card, revision: number): BoardChangeEvent => ({
  type: "card_upserted",
  card,
  revision,
});

export async function createCard(
  db: DB,
  actor: Actor,
  columnId: string,
  title: string,
  id?: string,
): Promise<BoardWrite<Card>> {
  return writeBoard(
    db,
    actor,
    boardOfColumn(db, columnId),
    {},
    async (trx, _board, boardId) => {
      // Still there, and on the board we locked?
      if ((await findColumn(trx, columnId)).board_id !== boardId) {
        throw new StoreError("not_found", "column not found");
      }
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
    },
    cardUpserted,
  );
}

export type CardEdit = Partial<Record<CardField, { value: string; baseVersion: number }>>;

export async function updateCard(
  db: DB,
  actor: Actor,
  cardId: string,
  edit: CardEdit,
): Promise<BoardWrite<Card>> {
  return writeBoard(
    db,
    actor,
    boardOfCard(db, cardId),
    {},
    async (trx, _board, boardId) => {
      // The board lock taken by writeBoard keeps this row stable until commit.
      const current = await trx
        .selectFrom("cards")
        .select([
          ...CARD_FIELDS,
          "title_version",
          "description_version",
          "title_changed_by",
          "description_changed_by",
        ])
        .where("id", "=", cardId)
        .where("board_id", "=", boardId)
        .executeTakeFirst();
      if (!current) throw new StoreError("not_found", "card not found");
      const fieldVersion = {
        title: current.title_version,
        description: current.description_version,
      };
      const changedBy = {
        title: current.title_changed_by,
        description: current.description_changed_by,
      };

      const changed: CardField[] = [];
      const conflicts: CardField[] = [];
      for (const field of ["title", "description"] as const) {
        const change = edit[field];
        if (!change || change.value === current[field]) continue; // nothing to do
        // Changed since this edit started, by someone else? Our own earlier
        // edit (say, an earlier one queued offline) isn't a conflict.
        const changedByOther = changedBy[field] !== actor.userId;
        if (fieldVersion[field] > change.baseVersion && changedByOther) conflicts.push(field);
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
          ...(changed.includes("title")
            ? { title: edit.title!.value, title_version: version, title_changed_by: actor.userId }
            : {}),
          ...(changed.includes("description")
            ? {
                description: edit.description!.value,
                description_version: version,
                description_changed_by: actor.userId,
              }
            : {}),
        })
        .where("id", "=", cardId)
        .where("board_id", "=", boardId)
        .returning(CARD_FIELDS)
        .executeTakeFirstOrThrow();
      return toCard(row);
    },
    cardUpserted,
  );
}

export async function moveCard(
  db: DB,
  actor: Actor,
  cardId: string,
  toColumnId: string,
  afterId: string | null,
  beforeId: string | null,
): Promise<BoardWrite<Card>> {
  return writeBoard(
    db,
    actor,
    boardOfCard(db, cardId),
    {},
    async (trx, _board, boardId) => {
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
        .where("board_id", "=", boardId)
        .returning(CARD_FIELDS)
        .executeTakeFirst();
      if (!row) throw new StoreError("not_found", "card not found"); // deleted meanwhile
      return toCard(row);
    },
    cardUpserted,
  );
}

export async function deleteCard(db: DB, actor: Actor, cardId: string): Promise<BoardWrite<Card>> {
  return writeBoard(
    db,
    actor,
    boardOfCard(db, cardId),
    {},
    async (trx, _board, boardId) => {
      const row = await trx
        .deleteFrom("cards")
        .where("id", "=", cardId)
        .where("board_id", "=", boardId)
        .returning(CARD_FIELDS)
        .executeTakeFirst();
      if (!row) throw new StoreError("not_found", "card not found");
      return toCard(row);
    },
    (card, revision, boardId) => ({ type: "card_deleted", boardId, cardId: card.id, revision }),
  );
}
