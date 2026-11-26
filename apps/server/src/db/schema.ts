import type { ColumnType, Generated, Kysely } from "kysely";

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
  created_at: CreatedAt;
  updated_at: Timestamp;
}

export interface Database {
  users: UsersTable;
  sessions: SessionsTable;
  boards: BoardsTable;
  board_members: BoardMembersTable;
  board_columns: BoardColumnsTable;
  cards: CardsTable;
}

export type DB = Kysely<Database>;
