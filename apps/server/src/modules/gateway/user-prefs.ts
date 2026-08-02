// Per-user preferences, cached across the connections of one user (audit
// backlog: `#sendDelaySeconds` queried per msg.send — a database round trip
// on the hot send path, for a row that changes about never).
//
// One entry per user, shared by every browser that user has attached, dropped
// by the prefs fan-out in `#patchPrefs`. The HighlightMatcher and the
// NotificationStore cache their own slices of the same row the same way; this
// is the third and holds the whole resolved document, so the gateway's own
// reads (snapshot self, send delay, ready-frame mute filtering) cost nothing
// after the first.

import { eq } from "drizzle-orm";
import { resolvePrefs, type UserPrefs } from "@emberchat/protocol";
import type { Db } from "../../db/index.js";
import { userPreferences } from "../../db/schema.js";

export interface ResolvedUserPrefs {
  sendDelaySeconds: number;
  prefs: UserPrefs;
}

export class UserPrefsCache {
  readonly #db: Db;
  readonly #byUser = new Map<string, ResolvedUserPrefs>();
  /** Bumped by invalidate(): a load that began before the bump must not
   * populate the cache — its SELECT saw the pre-patch row, and a stale entry
   * would park the old prefs there until the next write (same guard, same
   * reason, as HighlightMatcher's). */
  readonly #generation = new Map<string, number>();
  /** Coalesces the concurrent misses a cold hello fires off. */
  readonly #inFlight = new Map<string, Promise<ResolvedUserPrefs>>();

  constructor(db: Db) {
    this.#db = db;
  }

  /** The user's preferences; absent row = all defaults. */
  async get(userId: string): Promise<ResolvedUserPrefs> {
    const cached = this.#byUser.get(userId);
    if (cached !== undefined) {
      return cached;
    }
    const pending = this.#inFlight.get(userId);
    if (pending !== undefined) {
      return pending;
    }
    const generation = this.#gen(userId);
    const settle = () => {
      // Only if it is still ours: an invalidation mid-load starts a fresh
      // one, and this handler must not evict its successor.
      if (this.#inFlight.get(userId) === load) {
        this.#inFlight.delete(userId);
      }
    };
    const load: Promise<ResolvedUserPrefs> = this.#load(userId).then(
      (value) => {
        if (generation === this.#gen(userId)) {
          this.#byUser.set(userId, value);
        }
        settle();
        return value;
      },
      (error: unknown) => {
        settle();
        throw error;
      },
    );
    this.#inFlight.set(userId, load);
    return load;
  }

  /** Drop after a prefs write, from whichever device made it. */
  invalidate(userId: string): void {
    this.#generation.set(userId, this.#gen(userId) + 1);
    this.#byUser.delete(userId);
    // A load already in flight read the pre-patch row; the next caller must
    // not be handed it.
    this.#inFlight.delete(userId);
  }

  #gen(userId: string): number {
    return this.#generation.get(userId) ?? 0;
  }

  async #load(userId: string): Promise<ResolvedUserPrefs> {
    const [row] = await this.#db
      .select({
        sendDelaySeconds: userPreferences.sendDelaySeconds,
        prefs: userPreferences.prefs,
      })
      .from(userPreferences)
      .where(eq(userPreferences.userId, userId))
      .limit(1);
    return {
      sendDelaySeconds: row?.sendDelaySeconds ?? 0,
      prefs: resolvePrefs(row?.prefs),
    };
  }
}
