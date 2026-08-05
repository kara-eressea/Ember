// Social fetch/fan-out service (M6 step 7, #199). One owner for the four
// upstream list calls, so the REST GET and the RTB-driven refresh (#364)
// share the same identity scoping, cache write and gateway broadcast — and
// the same shared 1 req/s per-account budget inside FlistApiClient.
//
// RTB friend events (a friend request accepted on the website) used to only
// drop the cache: nothing refetched and nothing was pushed, so the new
// friend stayed in the sidebar's DM section until a manual ↻. refreshSoon()
// closes that: coalesced per identity, four calls at most per burst.

import { eq } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import type { Db } from "../../db/index.js";
import { flistAccounts, identities } from "../../db/schema.js";
import type {
  FlistApiClient,
  SessionRegistry,
  TicketManagerRegistry,
} from "@emberchat/session-engine";
import { withTicket, type TicketedIdentity } from "../flist-api/with-ticket.js";
import type { GatewayHub } from "../gateway/gateway.js";
import { enrichSocial, type SocialCache, type SocialLists } from "./cache.js";

export interface SocialIdentity extends TicketedIdentity {
  id: string;
  character: string;
}

/** Envelope failures come back as text; transport failures reject (the
 * routes map those through upstreamStatus). */
export type SocialFetchResult =
  | { lists: SocialLists; error?: undefined }
  | { lists?: undefined; error: string };

/** An accept lands friendadd on both parties and often rides alongside a
 * friendrequest event — one burst must cost one refetch, not one each. */
export const SOCIAL_REFRESH_DEBOUNCE_MS = 500;

export interface SocialServiceOptions {
  db: Db;
  sessions: SessionRegistry;
  tickets: TicketManagerRegistry;
  flistApi: FlistApiClient;
  cache: SocialCache;
  hub: GatewayHub;
  logger: FastifyBaseLogger;
  /** Test-only knob. */
  debounceMs?: number;
}

export class SocialService {
  readonly #db: Db;
  readonly #sessions: SessionRegistry;
  readonly #tickets: TicketManagerRegistry;
  readonly #flistApi: FlistApiClient;
  readonly #cache: SocialCache;
  readonly #hub: GatewayHub;
  readonly #log: FastifyBaseLogger;
  readonly #debounceMs: number;
  readonly #timers = new Map<string, NodeJS.Timeout>();
  readonly #running = new Set<string>();
  readonly #again = new Set<string>();

  constructor(options: SocialServiceOptions) {
    this.#db = options.db;
    this.#sessions = options.sessions;
    this.#tickets = options.tickets;
    this.#flistApi = options.flistApi;
    this.#cache = options.cache;
    this.#hub = options.hub;
    this.#log = options.logger;
    this.#debounceMs = options.debounceMs ?? SOCIAL_REFRESH_DEBOUNCE_MS;
  }

  /** Enriched lists from the live roster (case-insensitive — #218). */
  enriched(identityId: string, lists: SocialLists) {
    return enrichSocial(
      lists,
      this.#sessions.get(identityId)?.state.characters,
    );
  }

  /** Fan-out to every attached device (#199). */
  broadcast(identityId: string, lists: SocialLists): void {
    this.#hub.broadcast(identityId, {
      kind: "social.updated",
      d: { social: this.enriched(identityId, lists) },
    });
  }

  /**
   * Four upstream calls → cache → fan-out. Caches the raw identity-scoped
   * lists; enrichment happens at serve time against the live roster so
   * presence stays current (#218).
   */
  async fetch(identity: SocialIdentity): Promise<SocialFetchResult> {
    const [bookmarks, friends, incoming, outgoing] = await Promise.all([
      withTicket(this.#tickets, identity, (auth) =>
        this.#flistApi.bookmarkList(auth),
      ),
      withTicket(this.#tickets, identity, (auth) =>
        this.#flistApi.friendList(auth),
      ),
      withTicket(this.#tickets, identity, (auth) =>
        this.#flistApi.requestList(auth),
      ),
      withTicket(this.#tickets, identity, (auth) =>
        this.#flistApi.requestPending(auth),
      ),
    ]);
    const failed = [bookmarks, friends, incoming, outgoing].find(
      (result) => result.error !== "",
    );
    if (failed) {
      return { error: failed.error };
    }
    // Account-wide pairs scoped to this identity: source is our character,
    // dest the friend (same orientation as friend-remove). F-Chat resolves
    // names case-insensitively, so the JSON API's casing for our own
    // character may diverge from the identity's stored casing; fold before
    // matching or a genuine friend/request silently drops (#265).
    const ownLower = identity.character.toLowerCase();
    const lists: SocialLists = {
      bookmarks: bookmarks.characters ?? [],
      friends: (friends.friends ?? [])
        .filter((pair) => pair.source.toLowerCase() === ownLower)
        .map((pair) => pair.dest),
      incoming: (incoming.requests ?? [])
        .filter((entry) => entry.dest.toLowerCase() === ownLower)
        .map((entry) => ({ id: entry.id, name: entry.source })),
      outgoing: (outgoing.requests ?? [])
        .filter((entry) => entry.source.toLowerCase() === ownLower)
        .map((entry) => ({ id: entry.id, name: entry.dest })),
    };
    this.#cache.set(identity.id, lists);
    // Every upstream fetch fans out, so a forced refresh on one device
    // syncs every other attached device too (#199).
    this.broadcast(identity.id, lists);
    return { lists };
  }

  /**
   * Refetch + fan-out for an identity known only by id (the RTB path).
   * Coalesced: a burst inside the debounce window, or arriving while a
   * fetch is in flight, costs one further refetch at most.
   */
  refreshSoon(identityId: string): void {
    if (this.#timers.has(identityId)) {
      return;
    }
    const timer = setTimeout(() => {
      this.#timers.delete(identityId);
      void this.#refresh(identityId);
    }, this.#debounceMs);
    timer.unref();
    this.#timers.set(identityId, timer);
  }

  /** Drops scheduled refreshes (shutdown). */
  stop(): void {
    for (const timer of this.#timers.values()) {
      clearTimeout(timer);
    }
    this.#timers.clear();
    this.#again.clear();
  }

  async #refresh(identityId: string): Promise<void> {
    if (this.#running.has(identityId)) {
      // Straddling an in-flight fetch: remember to run once more rather
      // than racing two four-call fetches into the same cache slot.
      this.#again.add(identityId);
      return;
    }
    this.#running.add(identityId);
    try {
      const identity = await this.#identity(identityId);
      if (!identity) {
        return;
      }
      const result = await this.fetch(identity);
      if (result.error !== undefined) {
        this.#log.warn(
          { identityId, error: result.error },
          "social refresh refused upstream",
        );
      }
    } catch (error) {
      // A locked vault or a shed call is not worth failing loudly for —
      // the lists stay uncached and the next GET fetches the truth.
      this.#log.warn({ identityId, err: error }, "social refresh failed");
    } finally {
      this.#running.delete(identityId);
      if (this.#again.delete(identityId)) {
        this.refreshSoon(identityId);
      }
    }
  }

  async #identity(identityId: string): Promise<SocialIdentity | undefined> {
    const [row] = await this.#db
      .select({
        id: identities.id,
        character: identities.characterName,
        accountId: flistAccounts.id,
        accountName: flistAccounts.accountName,
      })
      .from(identities)
      .innerJoin(flistAccounts, eq(identities.flistAccountId, flistAccounts.id))
      .where(eq(identities.id, identityId))
      .limit(1);
    return row;
  }
}
