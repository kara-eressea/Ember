// Per-identity in-memory cache of the social lists (#194). The server holds
// the F-Chat session, so it also holds the last-known bookmarks/friends —
// a second device attaching gets them instantly (snapshot) instead of four
// fresh F-List API calls. Volatile like the session vault: a restart just
// means the first GET refetches.
//
// The cache stores raw names/rows; presence enrichment happens at serve
// time against the live roster so status is never frozen at fetch time
// (#218) — and the lookup is case-insensitive, because the JSON API and
// the chat roster do not always agree on casing.

import type { SocialCharacterDto, SocialDto } from "@emberchat/protocol";
import type { CharacterPresence } from "../session-engine/session-state.js";

/** Raw identity-scoped lists, as filtered from the account-wide upstream. */
export interface SocialLists {
  bookmarks: string[];
  friends: string[];
  incoming: { id: number; name: string }[];
  outgoing: { id: number; name: string }[];
}

interface Entry extends SocialLists {
  fetchedAt: number;
}

/** GET serves the cache inside this window; older entries refetch. The
 * snapshot serves whatever is cached regardless of age — the manual
 * refresh button (and this TTL on the next GET) covers staleness. */
export const SOCIAL_CACHE_TTL_MS = 15 * 60_000;

export class SocialCache {
  readonly #entries = new Map<string, Entry>();
  readonly #ttlMs: number;
  readonly #now: () => number;

  constructor(options?: { ttlMs?: number; now?: () => number }) {
    this.#ttlMs = options?.ttlMs ?? SOCIAL_CACHE_TTL_MS;
    this.#now = options?.now ?? Date.now;
  }

  get(identityId: string): SocialLists | undefined {
    return this.#entries.get(identityId);
  }

  /** True when a cached entry exists and is inside the TTL window. */
  fresh(identityId: string): boolean {
    const entry = this.#entries.get(identityId);
    return entry !== undefined && this.#now() - entry.fetchedAt < this.#ttlMs;
  }

  set(identityId: string, lists: SocialLists): void {
    this.#entries.set(identityId, { ...lists, fetchedAt: this.#now() });
  }

  /**
   * Folds a known bookmark change into the cache (#199). A miss (nothing
   * cached yet) is a no-op — there is no list to patch, and the first GET
   * will fetch the post-change truth anyway. Returns the updated lists so
   * the caller can fan them out.
   */
  patchBookmark(
    identityId: string,
    action: "add" | "remove",
    name: string,
  ): SocialLists | undefined {
    const entry = this.#entries.get(identityId);
    if (!entry) {
      return undefined;
    }
    const lower = name.toLowerCase();
    if (action === "add") {
      if (!entry.bookmarks.some((b) => b.toLowerCase() === lower)) {
        entry.bookmarks = [...entry.bookmarks, name];
      }
    } else {
      entry.bookmarks = entry.bookmarks.filter(
        (b) => b.toLowerCase() !== lower,
      );
    }
    return entry;
  }

  /** Drops the entry — the next GET refetches. Used for friend/request
   * mutations and RTB friend events, whose upstream effects (request ids,
   * pair rows) cannot be patched locally. */
  invalidate(identityId: string): void {
    this.#entries.delete(identityId);
  }

  /** Identity deleted — drop its entry. */
  drop(identityId: string): void {
    this.#entries.delete(identityId);
  }
}

/**
 * Presence-enriches raw lists from a live roster (case-insensitive — the
 * bug class behind #218). An absent roster (session detached) renders
 * every row offline, matching prior behavior.
 */
export function enrichSocial(
  lists: SocialLists,
  roster: ReadonlyMap<string, CharacterPresence> | undefined,
): SocialDto {
  const byLower = new Map<string, CharacterPresence>();
  if (roster) {
    for (const [name, presence] of roster) {
      byLower.set(name.toLowerCase(), presence);
    }
  }
  const enrich = (name: string): SocialCharacterDto => {
    const presence = byLower.get(name.toLowerCase());
    return {
      name,
      online: presence !== undefined,
      status: presence?.status ?? "offline",
      statusmsg: presence?.statusmsg ?? "",
    };
  };
  return {
    bookmarks: lists.bookmarks.map(enrich),
    friends: lists.friends.map(enrich),
    incoming: lists.incoming.map((row) => ({ ...row })),
    outgoing: lists.outgoing.map((row) => ({ ...row })),
  };
}
