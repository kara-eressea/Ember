/**
 * One database fixture for the whole server suite (MX2, #298).
 *
 * Every db-backed test file used to build its own: start a testcontainers
 * Postgres, `createDb(uri)`, `migrate(...)`, tear both down. That was 19
 * copies of the same five lines, and it hard-coded the driver — so the
 * storage seam `createDb` now exposes could not be exercised by the suite it
 * most needs to be exercised by.
 *
 * `TEST_DB_DRIVER` picks:
 *
 *   container (default) — testcontainers `postgres:18-alpine`. Exactly what
 *                         ran before; the CI default, and what a bare
 *                         `pnpm test` gives you.
 *   pglite              — the embedded database the desktop client will use,
 *                         in a throwaway data directory. No Docker.
 *
 * Tests get `env` rather than a connection string: the two drivers are
 * configured by different variables, and spreading a fragment keeps the call
 * sites driver-agnostic (including the ones that hand an env to a child
 * process).
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { createDb, type Db, type DbHandle } from "../db/index.js";

const MIGRATIONS = fileURLToPath(new URL("../../drizzle", import.meta.url));

export type TestDbDriver = "container" | "pglite";

/** Which driver this run uses. Tests read it for driver-conditional skips. */
export const TEST_DB_DRIVER: TestDbDriver =
  process.env["TEST_DB_DRIVER"] === "pglite" ? "pglite" : "container";

export interface TestDb {
  readonly driver: TestDbDriver;
  readonly db: Db;
  readonly handle: DbHandle;
  /**
   * The database half of an env: spread into `loadConfig({ ...process.env,
   * ...testDb.env })` or a child process's environment.
   */
  readonly env: Record<string, string>;
  /** Closes the database and disposes whatever was backing it. */
  readonly stop: () => Promise<void>;
}

/** Boots a migrated, empty database for one test file. */
export async function makeTestDb(): Promise<TestDb> {
  return TEST_DB_DRIVER === "pglite"
    ? await makePgliteTestDb()
    : await makeContainerTestDb();
}

async function makeContainerTestDb(): Promise<TestDb> {
  const container: StartedPostgreSqlContainer = await new PostgreSqlContainer(
    "postgres:18-alpine",
  ).start();
  const connectionString = container.getConnectionUri();
  const handle = await createDb({ kind: "node-postgres", connectionString });
  await handle.migrate(MIGRATIONS);
  return {
    driver: "container",
    db: handle.db,
    handle,
    env: { DB_DRIVER: "node-postgres", DATABASE_URL: connectionString },
    stop: async () => {
      await handle.close();
      await container.stop();
    },
  };
}

async function makePgliteTestDb(): Promise<TestDb> {
  // A real directory rather than `memory://`, so the driver runs the same
  // filesystem path the desktop client does.
  //
  // What it does NOT buy is a second process: pglite is a whole Postgres in
  // one process, with no shared buffers and no data-directory lock. Two
  // processes over one directory see different databases — measured, not
  // assumed: a table created by the first is "relation does not exist" in
  // the second, and rows the second writes are invisible to the first. So a
  // test that hands `env` to a child (the admin CLI) can only do so while
  // nothing here holds the directory open. The desktop client's first run is
  // built exactly that way — migrate, stop the server, then the CLI
  // (apps/desktop/src/provisioning.ts) — and the CLI tests skip under this
  // driver rather than pretend otherwise.
  const dataDir = await mkdtemp(path.join(tmpdir(), "emberchat-test-db-"));
  const handle = await createDb({ kind: "pglite", dataDir });
  await handle.migrate(MIGRATIONS);
  return {
    driver: "pglite",
    db: handle.db,
    handle,
    env: { DB_DRIVER: "pglite", PGLITE_DATA_DIR: dataDir },
    stop: async () => {
      await handle.close();
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}
