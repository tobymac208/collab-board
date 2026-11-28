import { sql, type Kysely } from "kysely";

// Who last changed each editable card field. An edit only conflicts with
// changes made by someone else: a user's own earlier edit (for example two
// edits queued while offline, both based on the same version) never blocks
// their next one.

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE cards
      ADD COLUMN title_changed_by uuid REFERENCES users (id) ON DELETE SET NULL,
      ADD COLUMN description_changed_by uuid REFERENCES users (id) ON DELETE SET NULL
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE cards
      DROP COLUMN title_changed_by,
      DROP COLUMN description_changed_by
  `.execute(db);
}
