// Image-preview host registry (#342) — the live union of every user's
// `imagePreviewHosts` preference, cached in memory and folded into the SPA's
// CSP `img-src`/`media-src` so a host a user adds in Preferences is actually
// fetchable by the browser (an admin-only instance trusts all its users).
//
// The CSP header itself reads this through a helmet directive function
// (evaluated per response), so the only thing that has to change on a pref
// write is this cache: `refresh()` recomputes the union from the database.
// Nothing queries the DB per request. The set is small and writes are rare, so
// a full recompute on every relevant pref change is simpler and cheaper than
// incremental bookkeeping.

import { isNotNull } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { userPreferences } from "../db/schema.js";
import type { SessionLogger } from "../modules/session-engine/fchat-session.js";
import { extraMediaSourceString, unionPreviewHosts } from "./csp.js";

/** Yields each stored prefs document — injected so the union logic is testable
 * without a database. */
export type PreviewPrefsLoader = () => Promise<Iterable<unknown>>;

export class ImagePreviewHostRegistry {
  readonly #load: PreviewPrefsLoader;
  readonly #log: SessionLogger | undefined;
  /** Sanitized, de-duplicated union of every user's allowlisted hosts. */
  #hosts: string[] = [];
  /** Cached space-joined `https://<host>` extra sources for the CSP directive
   * (defaults excluded) — recomputed only on refresh, read per response. */
  #source = "";

  constructor(load: PreviewPrefsLoader, log?: SessionLogger) {
    this.#load = load;
    this.#log = log;
  }

  /** Build a registry backed by the `user_preferences` table. */
  static fromDb(db: Db, log?: SessionLogger): ImagePreviewHostRegistry {
    return new ImagePreviewHostRegistry(async () => {
      const rows = await db
        .select({ prefs: userPreferences.prefs })
        .from(userPreferences)
        .where(isNotNull(userPreferences.prefs));
      return rows.map((row) => row.prefs);
    }, log);
  }

  /** Recompute the cached union from the loader. Call at boot and whenever a
   * user's `imagePreviewHosts` preference changes. */
  async refresh(): Promise<void> {
    const docs = await this.#load();
    this.#hosts = unionPreviewHosts(docs, this.#log);
    this.#source = extraMediaSourceString(this.#hosts);
  }

  /** The sanitized union of user-added hosts (defaults included). */
  hosts(): readonly string[] {
    return this.#hosts;
  }

  /** The space-joined extra `https://<host>` sources for the CSP directive
   * function — empty string when the defaults already cover everything. */
  mediaSourceString(): string {
    return this.#source;
  }
}
