import { Kysely, PostgresDialect } from "kysely";
import pg from "pg";
import type { Database, DB } from "./schema.ts";

export function connect(databaseUrl: string): DB {
  return new Kysely<Database>({
    dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: databaseUrl, max: 10 }) }),
  });
}
