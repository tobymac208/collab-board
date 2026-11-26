import { sql, type Kysely } from "kysely";

// Card versions, for conflict detection. `version` increments on every change
// to a card. `title_version` and `description_version` record the card
// version at which that field last changed, so an edit based on an older
// version conflicts only if the field it touches changed since.

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE cards
      ADD COLUMN version integer NOT NULL DEFAULT 0,
      ADD COLUMN title_version integer NOT NULL DEFAULT 0,
      ADD COLUMN description_version integer NOT NULL DEFAULT 0
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE cards
      DROP COLUMN version,
      DROP COLUMN title_version,
      DROP COLUMN description_version
  `.execute(db);
}
