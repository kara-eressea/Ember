import { describe, expect, it } from "vitest";
import {
  FAILURE_WINDOW_MS,
  LOCKOUT_BASE_MS,
  LOCKOUT_MAX_MS,
  LOCKOUT_THRESHOLD,
  LoginLockout,
} from "./lockout.js";

const IP = "203.0.113.7";

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
      expect(lockout.recordFailure("kara@example.test", IP)).toBe(0);
      expect(lockout.lockedForMs("kara@example.test", IP)).toBe(0);
    }
    expect(lockout.recordFailure("kara@example.test", IP)).toBe(
      LOCKOUT_BASE_MS,
    );
    expect(lockout.lockedForMs("kara@example.test", IP)).toBe(LOCKOUT_BASE_MS);

    c.advance(LOCKOUT_BASE_MS - 1);
    expect(lockout.lockedForMs("kara@example.test", IP)).toBe(1);
    c.advance(1);
    expect(lockout.lockedForMs("kara@example.test", IP)).toBe(0);
  });

  it("doubles the window on further failures, capped at the max", () => {
    const c = clock();
    const lockout = new LoginLockout(c.now);
    for (let i = 0; i < LOCKOUT_THRESHOLD; i += 1) {
      lockout.recordFailure("kara@example.test", IP);
    }
    expect(lockout.recordFailure("kara@example.test", IP)).toBe(
      LOCKOUT_BASE_MS * 2,
    );
    expect(lockout.recordFailure("kara@example.test", IP)).toBe(
      LOCKOUT_BASE_MS * 4,
    );
    for (let i = 0; i < 10; i += 1) {
      lockout.recordFailure("kara@example.test", IP);
    }
    expect(lockout.recordFailure("kara@example.test", IP)).toBe(LOCKOUT_MAX_MS);
  });

  it("clears on success and after a quiet spell; emails are case-insensitive", () => {
    const c = clock();
    const lockout = new LoginLockout(c.now);
    for (let i = 0; i < LOCKOUT_THRESHOLD - 1; i += 1) {
      lockout.recordFailure("Kara@Example.Test", IP);
    }
    lockout.recordSuccess("kara@example.test", IP);
    expect(lockout.recordFailure("kara@example.test", IP)).toBe(0); // count reset

    // A quiet spell longer than the failure window also resets the count.
    for (let i = 0; i < LOCKOUT_THRESHOLD - 1; i += 1) {
      lockout.recordFailure("kara@example.test", IP);
    }
    c.advance(FAILURE_WINDOW_MS + 1);
    expect(lockout.recordFailure("kara@example.test", IP)).toBe(0);
  });

  it("keys on (email, IP): the same account from another IP is unaffected", () => {
    const lockout = new LoginLockout(() => 0);
    for (let i = 0; i < LOCKOUT_THRESHOLD; i += 1) {
      lockout.recordFailure("victim@example.test", "198.51.100.9"); // attacker IP
    }
    // The attacker's IP is locked...
    expect(lockout.lockedForMs("victim@example.test", "198.51.100.9")).toBe(
      LOCKOUT_BASE_MS,
    );
    // ...but the real owner, on their own IP, can still sign in.
    expect(lockout.lockedForMs("victim@example.test", "203.0.113.1")).toBe(0);
  });

  it("tracks accounts independently", () => {
    const lockout = new LoginLockout(() => 0);
    for (let i = 0; i < LOCKOUT_THRESHOLD; i += 1) {
      lockout.recordFailure("locked@example.test", IP);
    }
    expect(lockout.lockedForMs("locked@example.test", IP)).toBeGreaterThan(0);
    expect(lockout.lockedForMs("other@example.test", IP)).toBe(0);
  });
});
