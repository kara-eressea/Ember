// The embedded-database backup endpoint (#548) and the primitive under it.
//
// Two things get proved here, and they are separable on purpose:
//
//   1. the route's gate, both ways — a server whose driver has no
//      `dumpDataDir` must refuse, and one that has it must hand the bytes over
//      to an authenticated caller and nobody else. Both run against whichever
//      driver the suite is on, with the dump itself faked, because the gate is
//      a property of the route rather than of pglite.
//   2. the primitive itself, against real pglite regardless of
//      `TEST_DB_DRIVER`: `createDb` exposes it only on that driver, the
//      tarball is taken while the database is open and serving, and it
//      restores to exactly the state at dump time. That is MX2's spike finding
//      turned into a test that fails if pglite ever regresses it.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { buildApp } from "../../app.js";
import { loadConfig } from "../../config.js";
import { createDb } from "../../db/index.js";
import {
  CONTAINER_BOOT_MS,
  INTEGRATION_MS,
  LOADED_RUNNER_MS,
} from "../../test-support/budgets.js";
import { makeTestDb, type TestDb } from "../../test-support/db.js";
import { backupFilename, BACKUP_CONTENT_TYPE } from "./backup.js";

vi.setConfig({ testTimeout: INTEGRATION_MS });

const MIGRATIONS = fileURLToPath(new URL("../../../drizzle", import.meta.url));

/** Stands in for a real tarball: the route must not care what the bytes are. */
const FAKE_TARBALL = Buffer.from("not-really-a-tarball, but bytes are bytes");

let testDb: TestDb;
/** An instance that can back itself up, and one that cannot. */
let embedded: FastifyInstance;
let hosted: FastifyInstance;
let accessToken: string;
const dump = vi.fn(() => Promise.resolve(new Blob([FAKE_TARBALL])));

function testConfig() {
  return loadConfig({
    ...testDb.env,
    AUTH_SECRET: "integration-test-secret-0123456789abcdef",
    AUTH_RATE_LIMIT_MAX: "1000",
    RATE_LIMIT_MAX: "1000",
    REGISTRATION_ENABLED: "true",
  });
}

beforeAll(async () => {
  testDb = await makeTestDb();
  embedded = await buildApp({
    config: testConfig(),
    db: testDb.db,
    dumpDataDir: dump,
    logger: false,
  });
  // The same app minus the capability — which is exactly what a node-postgres
  // deployment builds, since `createDb` hands `buildApp` nothing to pass.
  hosted = await buildApp({
    config: testConfig(),
    db: testDb.db,
    logger: false,
  });
  const registered = await embedded.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: {
      email: "backup@example.test",
      username: "backup",
      password: "correct horse battery staple",
    },
  });
  expect(registered.statusCode).toBe(201);
  accessToken = registered.json<{ accessToken: string }>().accessToken;
}, CONTAINER_BOOT_MS);

afterAll(async () => {
  await embedded.close();
  await hosted.close();
  await testDb.stop();
});

describe("GET /api/backup", () => {
  it("hands the archive over as a dated download", async () => {
    dump.mockClear();
    const response = await embedded.inject({
      method: "GET",
      url: "/api/backup",
      headers: { authorization: `Bearer ${accessToken}` },
    });

    expect(response.statusCode).toBe(200);
    expect(dump).toHaveBeenCalledTimes(1);
    expect(response.headers["content-type"]).toBe(BACKUP_CONTENT_TYPE);
    // The name matters: this file is the thing the user keeps, and a browser
    // hitting the endpoint directly gets its name from here.
    expect(response.headers["content-disposition"]).toBe(
      `attachment; filename="${backupFilename(new Date())}"`,
    );
    expect(response.rawPayload.equals(FAKE_TARBALL)).toBe(true);
  });

  it("refuses an instance whose database it does not own", async () => {
    // The driver gate, closed. A server deployment's backup is its operator's
    // pg_dump — there is no data directory in this process to package up, and
    // the refusal says so rather than 404-ing silently.
    const response = await hosted.inject({
      method: "GET",
      url: "/api/backup",
      headers: { authorization: `Bearer ${accessToken}` },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json<{ error: string }>().error).toContain("pg_dump");
  });

  it("is authenticated — on both kinds of instance", async () => {
    // Loopback is not a permission: a desktop machine runs other people's
    // code too, and this endpoint hands over every message ever received.
    for (const app of [embedded, hosted]) {
      const response = await app.inject({ method: "GET", url: "/api/backup" });
      expect(response.statusCode).toBe(401);
    }
    // And the gate does not run before the guard: an unauthenticated caller
    // learns nothing about which driver this instance is on.
    dump.mockClear();
    await embedded.inject({ method: "GET", url: "/api/backup" });
    expect(dump).not.toHaveBeenCalled();
  });
});

describe("backupFilename", () => {
  it("names the product, the purpose and the day", () => {
    expect(backupFilename(new Date("2026-08-06T22:41:03.000Z"))).toBe(
      "emberchat-backup-2026-08-06.tar.gz",
    );
  });
});

describe("dumpDataDir, against real pglite", () => {
  // Independent of TEST_DB_DRIVER: the capability is pglite's, so the test
  // brings its own rather than waiting for the suite to be run on that leg.
  it(
    "is the embedded driver's alone",
    async () => {
      // No connection is attempted by the node-postgres arm (a Pool is lazy),
      // so this needs no database at all — it is a statement about the seam.
      const hostedHandle = await createDb({
        kind: "node-postgres",
        connectionString: "postgres://nobody@127.0.0.1:1/none",
      });
      expect(hostedHandle.dumpDataDir).toBeUndefined();
      await hostedHandle.close();
    },
    LOADED_RUNNER_MS,
  );

  it(
    "snapshots a running database, and the snapshot restores",
    async () => {
      const dataDir = await mkdtemp(path.join(tmpdir(), "emberchat-backup-"));
      const restoredDir = await mkdtemp(path.join(tmpdir(), "emberchat-rest-"));
      const handle = await createDb({ kind: "pglite", dataDir });
      try {
        await handle.migrate(MIGRATIONS);
        expect(handle.dumpDataDir).toBeDefined();
        await handle.db.execute(
          "create table backup_marker (id serial primary key, note text)",
        );
        await handle.db.execute(
          "insert into backup_marker (note) values ('before the dump')",
        );

        // Taken with the database open and mid-use — no quiet moment, no
        // downtime. That is the whole reason this replaced "quit first, then
        // copy the folder" (MX2 spike §4).
        const archive = await handle.dumpDataDir?.();
        const bytes = Buffer.from(await (archive as Blob).arrayBuffer());
        // gzip's magic number, so "it produced a file" is not the assertion.
        expect(bytes.subarray(0, 2)).toEqual(Buffer.from([0x1f, 0x8b]));
        expect(bytes.byteLength).toBeGreaterThan(1024);

        // A write after the dump must NOT be in it: a backup is a point in
        // time, and a caller who cannot say which point has nothing useful.
        await handle.db.execute(
          "insert into backup_marker (note) values ('after the dump')",
        );

        const { PGlite } = await import("@electric-sql/pglite");
        const restored = await PGlite.create(restoredDir, {
          loadDataDir: new Blob([bytes]),
        });
        try {
          const rows = await restored.query<{ note: string }>(
            "select note from backup_marker order by id",
          );
          expect(rows.rows.map((row) => row.note)).toEqual(["before the dump"]);
        } finally {
          await restored.close();
        }
      } finally {
        await handle.close();
        await rm(dataDir, { recursive: true, force: true });
        await rm(restoredDir, { recursive: true, force: true });
      }
    },
    LOADED_RUNNER_MS,
  );
});
