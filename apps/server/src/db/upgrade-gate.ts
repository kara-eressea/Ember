// Upgrade gate (M7): migrations run on boot, so a naive `docker pull` is
// also a schema upgrade. Two situations must never proceed silently:
//
// 1. The database is NEWER than this binary (an accidental downgrade —
//    older code against a newer schema can corrupt data), and
// 2. a pending migration is flagged BREAKING in drizzle/breaking.json
//    (destructive/incompatible changes — always a major version bump).
//
// Both refuse to boot with a loud, actionable error naming the backup step
// and the release notes; the breaking case proceeds only with the explicit
// CONFIRM_BREAKING_UPGRADE=true acknowledgment.

import { readFile } from "node:fs/promises";
import path from "node:path";

export interface JournalEntry {
  readonly when: number;
  readonly tag: string;
}

export interface UpgradeManifest {
  readonly journal: JournalEntry[];
  readonly breakingTags: string[];
}

export class UpgradeRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UpgradeRefusedError";
  }
}

/** Reads the drizzle journal + the breaking-migrations manifest. */
export async function loadUpgradeManifest(
  migrationsFolder: string,
): Promise<UpgradeManifest> {
  const journalRaw = await readFile(
    path.join(migrationsFolder, "meta", "_journal.json"),
    "utf8",
  );
  const journal = (
    JSON.parse(journalRaw) as { entries: JournalEntry[] }
  ).entries.map(({ when, tag }) => ({ when, tag }));
  let breakingTags: string[] = [];
  try {
    const breakingRaw = await readFile(
      path.join(migrationsFolder, "breaking.json"),
      "utf8",
    );
    breakingTags = (JSON.parse(breakingRaw) as { breaking: string[] }).breaking;
  } catch {
    // No manifest — nothing is flagged breaking.
  }
  return { journal, breakingTags };
}

export interface UpgradeGateOptions {
  /** Anything with pg's query shape (the pool from createDb). */
  readonly pool: {
    query: (sql: string) => Promise<{ rows: { created_at: string }[] }>;
  };
  readonly manifest: UpgradeManifest;
  /** CONFIRM_BREAKING_UPGRADE — the operator's explicit acknowledgment. */
  readonly confirmBreaking: boolean;
  readonly releasesUrl: string;
}

/**
 * Refuses (throws UpgradeRefusedError) when booting would downgrade the
 * database or cross an unacknowledged breaking migration. A fresh database
 * (no migrations table) always passes — there is nothing to break.
 */
export async function assertUpgradeSafe(
  options: UpgradeGateOptions,
): Promise<void> {
  const { pool, manifest, confirmBreaking, releasesUrl } = options;
  let applied: number[];
  try {
    const result = await pool.query(
      'select created_at from "drizzle"."__drizzle_migrations"',
    );
    applied = result.rows.map((row) => Number(row.created_at));
  } catch {
    return; // fresh database — drizzle hasn't created its bookkeeping yet
  }
  if (applied.length === 0) {
    return;
  }
  const appliedMax = Math.max(...applied);
  const binaryMax = Math.max(0, ...manifest.journal.map((e) => e.when));

  if (appliedMax > binaryMax) {
    throw new UpgradeRefusedError(
      [
        "REFUSING TO START: the database schema is NEWER than this binary.",
        "This looks like a downgrade (e.g. a rolled-back image against an already-migrated database).",
        "Running older code against a newer schema can corrupt data.",
        `Fix: run the release that migrated the database (or restore the pre-upgrade backup). Releases: ${releasesUrl}`,
      ].join("\n"),
    );
  }

  const pendingBreaking = manifest.journal.filter(
    (entry) =>
      entry.when > appliedMax && manifest.breakingTags.includes(entry.tag),
  );
  if (pendingBreaking.length > 0 && !confirmBreaking) {
    const tags = pendingBreaking.map((entry) => entry.tag).join(", ");
    throw new UpgradeRefusedError(
      [
        `REFUSING TO START: pending migration(s) flagged BREAKING: ${tags}.`,
        "This upgrade makes destructive/incompatible schema changes and cannot be rolled back by pulling an older image.",
        "Before proceeding:",
        "  1. Back up the database (pg_dump — see docs/self-hosting.md).",
        `  2. Read the release notes: ${releasesUrl}`,
        "  3. Start once with CONFIRM_BREAKING_UPGRADE=true to acknowledge (then remove the flag).",
      ].join("\n"),
    );
  }
}
