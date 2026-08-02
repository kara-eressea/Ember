// The per-user prefs cache behind msg.send's delay lookup (audit backlog:
// `#sendDelaySeconds` queried per message). The database is a counting fake —
// what matters here is exactly how many reads a burst of sends costs.

import { describe, expect, it } from "vitest";
import { UserPrefsCache } from "./user-prefs.js";

interface FakeDb {
  cache: UserPrefsCache;
  /** SELECTs issued so far. */
  queries: () => number;
  /** What the next SELECT returns. */
  setRow: (
    row: { sendDelaySeconds: number; prefs: unknown } | undefined,
  ) => void;
  /** Holds the next SELECT open until the returned resolver is called. */
  block: () => () => void;
}

function fakeCache(): FakeDb {
  let count = 0;
  let row: { sendDelaySeconds: number; prefs: unknown } | undefined = {
    sendDelaySeconds: 30,
    prefs: {},
  };
  let gate: Promise<void> | undefined;
  const chain = {
    from: () => chain,
    where: () => chain,
    limit: async () => {
      count += 1;
      // Snapshot at query time, like a real SELECT: a row written while this
      // query is in flight is not what it comes back with.
      const seen = row;
      await gate;
      return seen === undefined ? [] : [seen];
    },
  };
  const db = { select: () => chain };
  return {
    cache: new UserPrefsCache(
      db as unknown as ConstructorParameters<typeof UserPrefsCache>[0],
    ),
    queries: () => count,
    setRow: (next) => {
      row = next;
    },
    block: () => {
      let release!: () => void;
      gate = new Promise<void>((resolve) => {
        release = () => {
          gate = undefined;
          resolve();
        };
      });
      return release;
    },
  };
}

describe("UserPrefsCache", () => {
  it("reads the row once for a burst of sends", async () => {
    const fake = fakeCache();
    for (let i = 0; i < 20; i += 1) {
      expect((await fake.cache.get("user-1")).sendDelaySeconds).toBe(30);
    }
    expect(fake.queries()).toBe(1);
  });

  it("coalesces concurrent misses into one read", async () => {
    const fake = fakeCache();
    const release = fake.block();
    const all = Promise.all([
      fake.cache.get("user-1"),
      fake.cache.get("user-1"),
      fake.cache.get("user-1"),
    ]);
    release();
    await all;
    expect(fake.queries()).toBe(1);
  });

  it("re-reads after a prefs patch, and only for the patched user", async () => {
    const fake = fakeCache();
    await fake.cache.get("user-1");
    await fake.cache.get("user-2");
    expect(fake.queries()).toBe(2);

    fake.setRow({ sendDelaySeconds: 0, prefs: { accent: "moss" } });
    fake.cache.invalidate("user-1");
    expect((await fake.cache.get("user-1")).sendDelaySeconds).toBe(0);
    expect((await fake.cache.get("user-1")).prefs.accent).toBe("moss");
    // user-2 was never patched and still answers from its own entry.
    expect((await fake.cache.get("user-2")).sendDelaySeconds).toBe(30);
    expect(fake.queries()).toBe(3);
  });

  it("a load racing invalidate() must not populate the cache", async () => {
    // Same hazard the HighlightMatcher guards: the SELECT saw the pre-patch
    // row, so caching it would park stale prefs there until the next write.
    const fake = fakeCache();
    const release = fake.block();
    const stale = fake.cache.get("user-1");
    fake.setRow({ sendDelaySeconds: 90, prefs: {} });
    fake.cache.invalidate("user-1"); // the patch lands mid-load
    release();
    // The in-flight caller answers from the snapshot it read — acceptable.
    expect((await stale).sendDelaySeconds).toBe(30);
    // The next reader must see the patched row, not the cached stale one.
    expect((await fake.cache.get("user-1")).sendDelaySeconds).toBe(90);
    expect(fake.queries()).toBe(2);
  });

  it("an absent row resolves to the documented defaults", async () => {
    const fake = fakeCache();
    fake.setRow(undefined);
    const resolved = await fake.cache.get("user-1");
    expect(resolved.sendDelaySeconds).toBe(0);
    expect(resolved.prefs.autoAwayEnabled).toBe(false);
  });
});
