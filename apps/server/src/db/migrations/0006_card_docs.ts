import { sql, type Kysely } from "kysely";

// Card text becomes a CRDT document per card (phase 5). card_docs holds each
// document's encoded state; cards.title/description stay as a plain-text copy
// for lists, snapshots and search, refreshed from the document shortly after
// edits ("dirty" marks documents whose copy is behind).
//
// The per-field versions and authors from phases 3-4 existed to detect
// conflicting text edits, which a CRDT merges instead, so they go.

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE card_docs (
      card_id    uuid PRIMARY KEY REFERENCES cards (id) ON DELETE CASCADE,
      board_id   uuid NOT NULL REFERENCES boards (id) ON DELETE CASCADE,
      state      bytea NOT NULL,
      dirty      boolean NOT NULL DEFAULT false,
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `.execute(db);
  await sql`CREATE INDEX card_docs_dirty_idx ON card_docs (card_id) WHERE dirty`.execute(db);
  await sql`
    ALTER TABLE cards
      DROP COLUMN title_version,
      DROP COLUMN description_version,
      DROP COLUMN title_changed_by,
      DROP COLUMN description_changed_by
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE cards
      ADD COLUMN title_version integer NOT NULL DEFAULT 0,
      ADD COLUMN description_version integer NOT NULL DEFAULT 0,
      ADD COLUMN title_changed_by uuid REFERENCES users (id) ON DELETE SET NULL,
      ADD COLUMN description_changed_by uuid REFERENCES users (id) ON DELETE SET NULL
  `.execute(db);
  await sql`DROP TABLE IF EXISTS card_docs`.execute(db);
}
