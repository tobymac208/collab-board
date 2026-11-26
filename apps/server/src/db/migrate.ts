import { Migrator, type Migration, type MigrationProvider } from "kysely/migration";
import type { DB } from "./schema.ts";
import * as m0001 from "./migrations/0001_initial.ts";
import * as m0002 from "./migrations/0002_board_revision.ts";

/**
 * Migrations are registered explicitly rather than read from disk, so they
 * survive bundling and run identically in tests, dev and production.
 */
const migrations: Record<string, Migration> = {
  "0001_initial": m0001,
  "0002_board_revision": m0002,
};

const provider: MigrationProvider = { getMigrations: async () => migrations };

export async function migrateToLatest(db: DB): Promise<void> {
  const migrator = new Migrator({ db, provider });
  const { error, results } = await migrator.migrateToLatest();
  for (const r of results ?? []) {
    if (r.status === "Error") console.error(`migration ${r.migrationName} failed`);
  }
  if (error) throw error;
}
