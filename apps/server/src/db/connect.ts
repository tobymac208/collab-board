import { Kysely, PostgresDialect } from "kysely";
import pg from "pg";
import type { Database, DB } from "./schema.ts";

export function connect(databaseUrl: string): DB {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 10 });
  // An idle client can fail (e.g. Postgres restarts). pg emits that on the
  // pool, and an unhandled "error" event would crash the process. The pool
  // already discards the broken client and opens a new one on the next query,
  // so logging is enough.
  pool.on("error", (err) => {
    console.error("idle Postgres client error", err);
  });
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
}
