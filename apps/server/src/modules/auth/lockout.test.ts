import { describe, expect, it } from "vitest";
import {
  FAILURE_WINDOW_MS,
  LOCKOUT_BASE_MS,
  LOCKOUT_MAX_MS,
  LOCKOUT_THRESHOLD,
  LoginLockout,
} from "./lockout.js";

function clock(start = 0) {
  let now = start;
  return {
    now: () => now,
    advance(ms: number) {
      now += ms;
    },
  };
}

describe("LoginLockout", () => {
  it("locks after the threshold and unlocks when the window passes", () => {
    const c = clock();
    const lockout = new LoginLockout(c.now);
    for (let i = 0; i < LOCKOUT_THRESHOLD - 1; i += 1) {
      expect(lockout.recordFailure("kara@example.test")).toBe(0);
      expect(lockout.lockedForMs("kara@example.test")).toBe(0);
    }
    expect(lockout.recordFailure("kara@example.test")).toBe(LOCKOUT_BASE_MS);
    expect(lockout.lockedForMs("kara@example.test")).toBe(LOCKOUT_BASE_MS);

    c.advance(LOCKOUT_BASE_MS - 1);
    expect(lockout.lockedForMs("kara@example.test")).toBe(1);
    c.advance(1);
    expect(lockout.lockedForMs("kara@example.test")).toBe(0);
  });

  it("doubles the window on further failures, capped at the max", () => {
    const c = clock();
    const lockout = new LoginLockout(c.now);
    for (let i = 0; i < LOCKOUT_THRESHOLD; i += 1) {
      lockout.recordFailure("kara@example.test");
    }
    expect(lockout.recordFailure("kara@example.test")).toBe(
      LOCKOUT_BASE_MS * 2,
    );
    expect(lockout.recordFailure("kara@example.test")).toBe(
      LOCKOUT_BASE_MS * 4,
    );
    for (let i = 0; i < 10; i += 1) {
      lockout.recordFailure("kara@example.test");
    }
    expect(lockout.recordFailure("kara@example.test")).toBe(LOCKOUT_MAX_MS);
  });

  it("clears on success and after a quiet spell; emails are case-insensitive", () => {
    const c = clock();
    const lockout = new LoginLockout(c.now);
    for (let i = 0; i < LOCKOUT_THRESHOLD - 1; i += 1) {
      lockout.recordFailure("Kara@Example.Test");
    }
    lockout.recordSuccess("kara@example.test");
    expect(lockout.recordFailure("kara@example.test")).toBe(0); // count reset

    // A quiet spell longer than the failure window also resets the count.
    for (let i = 0; i < LOCKOUT_THRESHOLD - 1; i += 1) {
      lockout.recordFailure("kara@example.test");
    }
    c.advance(FAILURE_WINDOW_MS + 1);
    expect(lockout.recordFailure("kara@example.test")).toBe(0);
  });

  it("tracks accounts independently", () => {
    const lockout = new LoginLockout(() => 0);
    for (let i = 0; i < LOCKOUT_THRESHOLD; i += 1) {
      lockout.recordFailure("locked@example.test");
    }
    expect(lockout.lockedForMs("locked@example.test")).toBeGreaterThan(0);
    expect(lockout.lockedForMs("other@example.test")).toBe(0);
  });
});
