// The boot-time upgrade gate: a migrated database + the real journal pass;
// a database newer than the binary refuses (downgrade); a pending breaking
// migration refuses without CONFIRM_BREAKING_UPGRADE and proceeds with it.

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb } from "./index.js";
import {
  assertUpgradeSafe,
  loadUpgradeManifest,
  UpgradeRefusedError,
  type UpgradeManifest,
} from "./upgrade-gate.js";

const MIGRATIONS = fileURLToPath(new URL("../../drizzle", import.meta.url));

let container: StartedPostgreSqlContainer;
let pool: ReturnType<typeof createDb>["pool"];
let manifest: UpgradeManifest;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:18-alpine").start();
  const created = createDb(container.getConnectionUri());
  pool = created.pool;
  manifest = await loadUpgradeManifest(MIGRATIONS);
  await migrate(created.db, { migrationsFolder: MIGRATIONS });
}, 180_000);

afterAll(async () => {
  await pool.end();
  await container.stop();
});

const RELEASES = "https://github.com/kara-eressea/Ember/releases";

describe("upgrade gate", () => {
  it("reads the journal and passes on an up-to-date database", async () => {
    expect(manifest.journal.length).toBeGreaterThan(0);
    await expect(
      assertUpgradeSafe({
        pool,
        manifest,
        confirmBreaking: false,
        releasesUrl: RELEASES,
      }),
    ).resolves.toBeUndefined();
  });

  it("refuses when the database is newer than the binary (downgrade)", async () => {
    // A binary that only knows the first migration meets today's database.
    const oldBinary: UpgradeManifest = {
      journal: manifest.journal.slice(0, 1),
      breakingTags: [],
    };
    await expect(
      assertUpgradeSafe({
        pool,
        manifest: oldBinary,
        confirmBreaking: false,
        releasesUrl: RELEASES,
      }),
    ).rejects.toThrow(/NEWER than this binary/);
  });

  it("refuses a pending breaking migration until it is acknowledged", async () => {
    const future = {
      when: Date.now() + 1_000_000,
      tag: "9999_m99-breaking-change",
    };
    const withBreaking: UpgradeManifest = {
      journal: [...manifest.journal, future],
      breakingTags: [future.tag],
    };
    await expect(
      assertUpgradeSafe({
        pool,
        manifest: withBreaking,
        confirmBreaking: false,
        releasesUrl: RELEASES,
      }),
    ).rejects.toThrow(UpgradeRefusedError);
    await expect(
      assertUpgradeSafe({
        pool,
        manifest: withBreaking,
        confirmBreaking: false,
        releasesUrl: RELEASES,
      }),
    ).rejects.toThrow(/CONFIRM_BREAKING_UPGRADE/);
    // The acknowledgment lets it through; a pending NON-breaking migration
    // never needed one.
    await expect(
      assertUpgradeSafe({
        pool,
        manifest: withBreaking,
        confirmBreaking: true,
        releasesUrl: RELEASES,
      }),
    ).resolves.toBeUndefined();
    await expect(
      assertUpgradeSafe({
        pool,
        manifest: { journal: withBreaking.journal, breakingTags: [] },
        confirmBreaking: false,
        releasesUrl: RELEASES,
      }),
    ).resolves.toBeUndefined();
  });

  it("passes a fresh database (no drizzle bookkeeping) untouched", async () => {
    const failingPool = {
      query: () => Promise.reject(new Error("relation does not exist")),
    };
    await expect(
      assertUpgradeSafe({
        pool: failingPool,
        manifest,
        confirmBreaking: false,
        releasesUrl: RELEASES,
      }),
    ).resolves.toBeUndefined();
  });
});
