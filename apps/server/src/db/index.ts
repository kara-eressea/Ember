// The storage seam (MX2, #298). One factory, two drivers:
//
//   node-postgres — the server. A pg Pool over DATABASE_URL. The default;
//                   nothing about an existing deployment changes.
//   pglite        — the embedded Postgres the desktop client will run on
//                   (design/standalone-client.md §Storage). Same schema, same
//                   migrations, no dialect fork — the MX2 spike
//                   (design/mx2-pglite-spike.md) confirmed pglite 0.5.4 is
//                   PostgreSQL 18.3, so even `uuidv7()` needs no shim.
//
// The handle owns migrate() and close() because those are the only two things
// that differ per driver at the call sites — the drizzle migrator has a
// separate entry point per driver. main.ts and cli/admin.ts therefore never
// learn which driver they are on.
//
// @electric-sql/pglite is a devDependency on purpose: it is ~25 MB of WASM and
// the production server image must not carry it (the desktop bundle owns the
// real dependency). That is why the pglite arm loads it — and drizzle's pglite
// adapter, which imports it at module scope — through dynamic import().

import type { ExtractTablesWithRelations } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import pg from "pg";
import type { AppConfig } from "../config.js";
import * as schema from "./schema.js";

/**
 * Driver-agnostic drizzle database.
 *
 * Deliberately the shared supertype rather than `NodePgDatabase`:
 * `PgliteDatabase` is *not* assignable to it — the query-result HKT diverges
 * (`NodePgQueryResultHKT` vs `PgliteQueryResultHKT`) and that propagates into
 * every transaction signature (spike §Q2). Both drivers satisfy this.
 *
 * The cost of the widening is that `db.execute()` returns `unknown`; the one
 * call site that reads its result declares a row type (gateway/snapshot.ts).
 */
export type Db = PgDatabase<
  PgQueryResultHKT,
  typeof schema,
  ExtractTablesWithRelations<typeof schema>
>;

export type DbDriver =
  | { readonly kind: "node-postgres"; readonly connectionString: string }
  | { readonly kind: "pglite"; readonly dataDir: string };

/**
 * pg's query shape, narrowed to the one column the upgrade gate reads. Both
 * drivers satisfy it structurally, so the gate needs no adapter.
 */
export interface RawQuery {
  query: (sql: string) => Promise<{ rows: { created_at: string }[] }>;
}

export interface DbHandle {
  readonly driver: DbDriver["kind"];
  readonly db: Db;
  /** What the boot-time upgrade gate wants — see RawQuery. */
  readonly raw: RawQuery;
  /** Applies the shared drizzle migrations (the migrator differs per driver). */
  readonly migrate: (migrationsFolder: string) => Promise<void>;
  readonly close: () => Promise<void>;
}

export async function createDb(driver: DbDriver): Promise<DbHandle> {
  return driver.kind === "pglite"
    ? await createPgliteDb(driver.dataDir)
    : createNodePostgresDb(driver.connectionString);
}

function createNodePostgresDb(connectionString: string): DbHandle {
  const pool = new pg.Pool({ connectionString });
  // Idle pooled clients surface backend failures as an out-of-band 'error'
  // event (pg docs) — a Postgres restart, or a testcontainer stopping while
  // a client lingers (CI run 30743606355: FATAL 57P01 failed an all-green
  // suite). Unhandled, that event kills the whole process; the pool itself
  // recovers by replacing the client, so log and move on.
  pool.on("error", (error) => {
    console.error("pg pool: idle client error", error);
  });
  const db = drizzle(pool, { schema, casing: "snake_case" });
  return {
    driver: "node-postgres",
    db,
    raw: { query: (sql) => pool.query<{ created_at: string }>(sql) },
    migrate: (migrationsFolder) => migrate(db, { migrationsFolder }),
    close: () => pool.end(),
  };
}

async function createPgliteDb(dataDir: string): Promise<DbHandle> {
  const { PGlite, drizzlePglite, migratePglite } = await loadPglite();
  const client = await PGlite.create(dataDir);
  const db = drizzlePglite(client, { schema, casing: "snake_case" });
  return {
    driver: "pglite",
    db,
    raw: { query: (sql) => client.query<{ created_at: string }>(sql) },
    migrate: async (migrationsFolder) => {
      await migratePglite(db, { migrationsFolder });
    },
    close: () => client.close(),
  };
}

/**
 * pglite and drizzle's pglite adapter, loaded only when the pglite arm runs.
 * A production server image has neither (by design), so name that situation
 * rather than letting a bare MODULE_NOT_FOUND surface.
 */
async function loadPglite() {
  try {
    const [{ PGlite }, { drizzle: drizzlePglite }, { migrate: migratePglite }] =
      await Promise.all([
        import("@electric-sql/pglite"),
        import("drizzle-orm/pglite"),
        import("drizzle-orm/pglite/migrator"),
      ]);
    return { PGlite, drizzlePglite, migratePglite };
  } catch (cause) {
    throw new Error(
      [
        "DB_DRIVER=pglite needs the @electric-sql/pglite package, which is not installed here.",
        "The published server image deliberately does not bundle it (~25 MB of WASM) — pglite is the desktop client's embedded database, and the desktop bundle carries it.",
        "On a server: leave DB_DRIVER unset (node-postgres, the default) and point DATABASE_URL at your Postgres.",
        "In this repo: pnpm --filter @emberchat/server install (it is a devDependency).",
      ].join("\n"),
      { cause },
    );
  }
}

/**
 * The driver the environment asked for. `loadConfig` has already refused a
 * driver whose required setting is missing, so the throws here are a
 * type-narrowing backstop rather than the operator-facing error.
 */
export function dbDriverFrom(
  config: Pick<AppConfig, "DB_DRIVER" | "DATABASE_URL" | "PGLITE_DATA_DIR">,
): DbDriver {
  if (config.DB_DRIVER === "pglite") {
    if (config.PGLITE_DATA_DIR === undefined) {
      throw new Error("PGLITE_DATA_DIR is required when DB_DRIVER=pglite");
    }
    return { kind: "pglite", dataDir: config.PGLITE_DATA_DIR };
  }
  if (config.DATABASE_URL === undefined) {
    throw new Error("DATABASE_URL is required when DB_DRIVER=node-postgres");
  }
  return { kind: "node-postgres", connectionString: config.DATABASE_URL };
}

export * as schema from "./schema.js";
