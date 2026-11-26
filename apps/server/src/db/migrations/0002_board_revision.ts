import { sql, type Kysely } from "kysely";

// Every change to a board increments its revision, inside the same
// transaction as the change. Clients use it to apply broadcast events in
// order, and reconnecting clients will use it to catch up (phase 4).

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE boards ADD COLUMN revision integer NOT NULL DEFAULT 0`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE boards DROP COLUMN revision`.execute(db);
}
