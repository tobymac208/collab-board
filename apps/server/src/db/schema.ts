import type { ColumnType, Generated, Kysely } from "kysely";
import type { BoardChangeEvent } from "@collab/shared";

/** Kysely table types. Keep in sync with the migrations in ./migrations. */

type CreatedAt = ColumnType<Date, never, never>;
type Timestamp = ColumnType<Date, Date | undefined, Date>;

export interface UsersTable {
  id: Generated<string>;
  /** Stored lowercased; unique. */
  email: string;
  display_name: string;
  password_hash: string;
  created_at: CreatedAt;
}

export interface SessionsTable {
  /** SHA-256 of the session token. The raw token only ever lives in the cookie. */
  id: string;
  user_id: string;
  created_at: CreatedAt;
  expires_at: Date;
}

export interface BoardsTable {
  id: Generated<string>;
  name: string;
  created_by: string;
  /** Incremented by every change to the board, in the same transaction. */
  revision: ColumnType<number, never, number>;
  created_at: CreatedAt;
  updated_at: Timestamp;
}

export interface BoardMembersTable {
  board_id: string;
  user_id: string;
  role: "owner" | "editor";
  created_at: CreatedAt;
}

export interface BoardColumnsTable {
  id: Generated<string>;
  board_id: string;
  name: string;
  /** Fractional index key, `COLLATE "C"` so it sorts byte-wise. */
  position: string;
  created_at: CreatedAt;
}

export interface CardsTable {
  id: Generated<string>;
  board_id: string;
  column_id: string;
  title: string;
  description: ColumnType<string, string | undefined, string>;
  /** Fractional index key within the column, `COLLATE "C"`. */
  position: string;
  /** Incremented by every change to the card. */
  version: ColumnType<number, never, number>;

  created_at: CreatedAt;
  updated_at: Timestamp;
}

export interface BoardChangesTable {
  board_id: string;
  revision: number;
  /** The event as broadcast, minus any requestId. Inserted as JSON text. */
  event: ColumnType<BoardChangeEvent, string, never>;
  created_at: CreatedAt;
}

export interface AppliedOpsTable {
  op_id: string;
  user_id: string;
  board_id: string;
  /** The board revision the op produced. Its event is in board_changes. */
  revision: number;
  created_at: CreatedAt;
}

export interface CardDocsTable {
  card_id: string;
  board_id: string;
  /** The card's text document, encoded (see @collab/shared crdt). */
  state: Uint8Array;
  /** The plain-text copy on `cards` is behind the document. */
  dirty: ColumnType<boolean, boolean | undefined, boolean>;
  updated_at: Timestamp;
}

export interface Database {
  users: UsersTable;
  sessions: SessionsTable;
  boards: BoardsTable;
  board_members: BoardMembersTable;
  board_columns: BoardColumnsTable;
  cards: CardsTable;
  board_changes: BoardChangesTable;
  applied_ops: AppliedOpsTable;
  card_docs: CardDocsTable;
}

export type DB = Kysely<Database>;
