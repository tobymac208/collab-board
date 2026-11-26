import { sql, type Kysely } from "kysely";

// Migrations are written in plain SQL so the schema is readable without
// knowing Kysely's schema builder. Never edit a migration after it has been
// merged; add a new one instead.

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE users (
      id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      email         text NOT NULL UNIQUE CHECK (email = lower(email)),
      display_name  text NOT NULL,
      password_hash text NOT NULL,
      created_at    timestamptz NOT NULL DEFAULT now()
    )
  `.execute(db);

  await sql`
    CREATE TABLE sessions (
      id         text PRIMARY KEY,
      user_id    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
      created_at timestamptz NOT NULL DEFAULT now(),
      expires_at timestamptz NOT NULL
    )
  `.execute(db);
  await sql`CREATE INDEX sessions_user_id_idx ON sessions (user_id)`.execute(db);

  await sql`
    CREATE TABLE boards (
      id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name       text NOT NULL,
      created_by uuid NOT NULL REFERENCES users (id),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `.execute(db);

  await sql`
    CREATE TABLE board_members (
      board_id   uuid NOT NULL REFERENCES boards (id) ON DELETE CASCADE,
      user_id    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
      role       text NOT NULL CHECK (role IN ('owner', 'editor')),
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (board_id, user_id)
    )
  `.execute(db);
  await sql`CREATE INDEX board_members_user_id_idx ON board_members (user_id)`.execute(db);

  // Positions are fractional index keys (e.g. "a0", "a0V"). They must compare
  // byte-wise, which the default locale collation does not guarantee, hence
  // COLLATE "C". The unique constraints turn an ordering bug into a loud error
  // instead of two items silently sharing a slot.
  await sql`
    CREATE TABLE board_columns (
      id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      board_id   uuid NOT NULL REFERENCES boards (id) ON DELETE CASCADE,
      name       text NOT NULL,
      position   text COLLATE "C" NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (board_id, position)
    )
  `.execute(db);

  await sql`
    CREATE TABLE cards (
      id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      board_id    uuid NOT NULL REFERENCES boards (id) ON DELETE CASCADE,
      column_id   uuid NOT NULL REFERENCES board_columns (id) ON DELETE CASCADE,
      title       text NOT NULL,
      description text NOT NULL DEFAULT '',
      position    text COLLATE "C" NOT NULL,
      created_at  timestamptz NOT NULL DEFAULT now(),
      updated_at  timestamptz NOT NULL DEFAULT now(),
      UNIQUE (column_id, position)
    )
  `.execute(db);
  await sql`CREATE INDEX cards_board_id_idx ON cards (board_id)`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  for (const table of ["cards", "board_columns", "board_members", "boards", "sessions", "users"]) {
    await sql`DROP TABLE IF EXISTS ${sql.table(table)}`.execute(db);
  }
}
