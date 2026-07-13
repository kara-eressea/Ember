// The retention scaffold: policy validation at boot, sweep scheduling, and
// the forever no-op. Real deletion policies (and their DB-backed tests)
// arrive with M7.

import { afterEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../../db/index.js";
import { loadConfig } from "../../config.js";
import { RetentionJob } from "./retention.js";

const DB = {} as Db; // "forever" never touches the database

function makeJob(intervalMs = 60_000) {
  return new RetentionJob({
    db: DB,
    policy: "forever",
    sweepIntervalMs: intervalMs,
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("retention config", () => {
  const BASE = {
    DATABASE_URL: "postgres://example/db",
    AUTH_SECRET: "integration-test-secret-0123456789abcdef",
  };

  it("defaults to forever", () => {
    const config = loadConfig(BASE);
    expect(config.RETENTION_POLICY).toBe("forever");
    expect(config.RETENTION_SWEEP_INTERVAL_MS).toBe(6 * 60 * 60 * 1000);
  });

  it("refuses an unknown policy at boot instead of silently keeping forever", () => {
    expect(() =>
      loadConfig({ ...BASE, RETENTION_POLICY: "30-days" }),
    ).toThrow();
  });
});

describe("retention job", () => {
  it("sweeps on the configured interval and stops cleanly", async () => {
    vi.useFakeTimers();
    const job = makeJob(1000);
    const sweep = vi.spyOn(job, "sweepOnce");
    job.start();
    job.start(); // idempotent — no double timer
    await vi.advanceTimersByTimeAsync(3000);
    expect(sweep).toHaveBeenCalledTimes(3);
    job.stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(sweep).toHaveBeenCalledTimes(3);
  });

  it("the forever policy deletes nothing", async () => {
    await expect(makeJob().sweepOnce()).resolves.toEqual({ deleted: 0 });
  });
});
