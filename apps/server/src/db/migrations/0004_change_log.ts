import { sql, type Kysely } from "kysely";

// board_changes: every board change event, by revision, so a client that
// reconnects can fetch just what it missed instead of the whole board.
//
// applied_ops: which client changes (by opId) have been applied and at what
// revision, so a change resent after a dropped connection isn't applied twice.
//
// Both are pruned after a while (see pruneHistory); a client that's been away
// longer gets a full snapshot instead.

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE board_changes (
      board_id   uuid NOT NULL REFERENCES boards (id) ON DELETE CASCADE,
      revision   integer NOT NULL,
      event      jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (board_id, revision)
    )
  `.execute(db);
  await sql`CREATE INDEX board_changes_created_at_idx ON board_changes (created_at)`.execute(db);

  await sql`
    CREATE TABLE applied_ops (
      op_id      uuid PRIMARY KEY,
      user_id    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
      board_id   uuid NOT NULL REFERENCES boards (id) ON DELETE CASCADE,
      revision   integer NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `.execute(db);
  await sql`CREATE INDEX applied_ops_created_at_idx ON applied_ops (created_at)`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE IF EXISTS applied_ops`.execute(db);
  await sql`DROP TABLE IF EXISTS board_changes`.execute(db);
}
