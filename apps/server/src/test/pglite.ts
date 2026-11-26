import { PGlite } from "@electric-sql/pglite";
import {
  CompiledQuery,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type DatabaseConnection,
  type Dialect,
  type Driver,
  type QueryResult,
} from "kysely";
import { migrateToLatest } from "../db/migrate.ts";
import type { Database, DB } from "../db/schema.ts";

/**
 * Kysely driver for PGlite (Postgres compiled to WASM), so tests run against
 * real Postgres without Docker.
 *
 * PGlite is a single connection. Kysely assumes a pool, so connections are
 * handed out one at a time behind a lock; without it, two concurrent
 * transactions would interleave their statements on the same session.
 */
class PGliteDriver implements Driver {
  #lock: Promise<void> = Promise.resolve();

  constructor(private readonly client: PGlite) {}

  async init(): Promise<void> {}

  async acquireConnection(): Promise<DatabaseConnection> {
    let release!: () => void;
    const previous = this.#lock;
    this.#lock = new Promise((resolve) => (release = resolve));
    await previous;
    return new PGliteConnection(this.client, release);
  }

  async releaseConnection(connection: DatabaseConnection): Promise<void> {
    (connection as PGliteConnection).release();
  }

  async beginTransaction(connection: DatabaseConnection): Promise<void> {
    await connection.executeQuery(CompiledQuery.raw("BEGIN"));
  }

  async commitTransaction(connection: DatabaseConnection): Promise<void> {
    await connection.executeQuery(CompiledQuery.raw("COMMIT"));
  }

  async rollbackTransaction(connection: DatabaseConnection): Promise<void> {
    await connection.executeQuery(CompiledQuery.raw("ROLLBACK"));
  }

  async destroy(): Promise<void> {
    await this.client.close();
  }
}

class PGliteConnection implements DatabaseConnection {
  constructor(
    private readonly client: PGlite,
    readonly release: () => void,
  ) {}

  async executeQuery<R>(query: CompiledQuery): Promise<QueryResult<R>> {
    const result = await this.client.query<R>(query.sql, [...query.parameters]);
    return {
      rows: result.rows,
      ...(result.affectedRows === undefined
        ? {}
        : { numAffectedRows: BigInt(result.affectedRows) }),
    };
  }

  // eslint-disable-next-line require-yield
  async *streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {
    throw new Error("PGlite driver does not support streaming");
  }
}

const dialect = (client: PGlite): Dialect => ({
  createAdapter: () => new PostgresAdapter(),
  createDriver: () => new PGliteDriver(client),
  createIntrospector: (db) => new PostgresIntrospector(db),
  createQueryCompiler: () => new PostgresQueryCompiler(),
});

/** A fresh, migrated, in-memory database. */
export async function createTestDb(): Promise<DB> {
  const db = new Kysely<Database>({ dialect: dialect(new PGlite()) });
  await migrateToLatest(db);
  return db;
}
