// Profile service (M8): fetch-through-cache over character-data.php with the
// 170/hour budget in front, server-side resolution of raw payloads against
// the bulk mapping lists into ProfileDto, per-identity view history, private
// notes, and insights computed from data the bouncer already holds.

import { and, desc, eq, lt, sql } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import {
  characterDataSchema,
  mappingListSchema,
  type CharacterData,
  type MappingList,
} from "@emberchat/fchat-protocol";
import type {
  GuestbookPage,
  ProfileDto,
  ProfileHistoryEntry,
  ProfileInsights,
} from "@emberchat/protocol";
import type { Db } from "../../db/index.js";
import {
  characterCache,
  characterNotes,
  conversations,
  flistMappings,
  messages,
  profileViews,
} from "../../db/schema.js";
import {
  FlistApiBusyError,
  type FlistApiClient,
} from "../flist-api/api-client.js";
import type { CharacterDataBudget } from "../flist-api/character-data-budget.js";
import {
  AccountLockedError,
  type TicketManagerRegistry,
} from "../flist-api/ticket-manager.js";
import { withTicket, type TicketedIdentity } from "../flist-api/with-ticket.js";
import type { SessionRegistry } from "../session-engine/registry.js";

export interface ProfileServiceOptions {
  db: Db;
  flistApi: FlistApiClient;
  tickets: TicketManagerRegistry;
  budget: CharacterDataBudget;
  sessions: SessionRegistry;
  logger: FastifyBaseLogger;
  /** Cache freshness window; stale rows refetch through the budget. */
  cacheTtlMs: number;
  /** Bulk mapping-list refresh window (~7 days). */
  mappingsTtlMs: number;
  now?: () => number;
}

export interface ProfileIdentity extends TicketedIdentity {
  id: string;
  character: string;
}

export type ProfileResult =
  | {
      status: "ok";
      profile: ProfileDto;
      fetchedAt: number;
      stale: boolean;
      budgetExhausted: boolean;
      note: string | null;
    }
  | { status: "not-found"; error: string }
  | { status: "budget-exhausted"; retryAfterSeconds: number };

/** The per-character half of getProfile — everything up to the cache write,
 * shared between coalesced concurrent callers (audit: in-flight dedup). */
type PayloadResult =
  | {
      status: "ok";
      payload: CharacterData;
      canonical: string;
      fetchedAt: number;
      stale: boolean;
      budgetExhausted: boolean;
    }
  | { status: "not-found"; error: string }
  | { status: "budget-exhausted"; retryAfterSeconds: number };

export type GuestbookResult =
  | { status: "ok"; page: GuestbookPage }
  | { status: "no-guestbook" }
  | { status: "budget-exhausted"; retryAfterSeconds: number }
  | { status: "upstream-error"; error: string };

const IMAGE_BASE = "https://static.f-list.net/images/charimage";
const INLINE_BASE = "https://static.f-list.net/images/charinline";
const KINK_CHOICES = new Set(["fave", "yes", "maybe", "no"]);

export class ProfileService {
  readonly #db: Db;
  readonly #api: FlistApiClient;
  readonly #tickets: TicketManagerRegistry;
  readonly #budget: CharacterDataBudget;
  readonly #sessions: SessionRegistry;
  readonly #log: FastifyBaseLogger;
  readonly #cacheTtlMs: number;
  readonly #mappingsTtlMs: number;
  readonly #now: () => number;
  /** In-memory view of the flist_mappings row — refreshed through the DB so
   * a restart never refetches a fresh payload. */
  #mappings: { data: MappingList; fetchedAt: number } | undefined;
  #mappingsRefresh: Promise<MappingList> | undefined;
  /** Coalesces concurrent loads of the same character so N simultaneous
   * surfaces (viewer + mini card + compare) spend one budget unit, not N —
   * mirrors the #mappingsRefresh pattern (M8 audit). */
  readonly #profileLoads = new Map<string, Promise<PayloadResult>>();

  constructor(options: ProfileServiceOptions) {
    this.#db = options.db;
    this.#api = options.flistApi;
    this.#tickets = options.tickets;
    this.#budget = options.budget;
    this.#sessions = options.sessions;
    this.#log = options.logger;
    this.#cacheTtlMs = options.cacheTtlMs;
    this.#mappingsTtlMs = options.mappingsTtlMs;
    this.#now = options.now ?? Date.now;
  }

  /** Fetch-through-cache. `refresh` bypasses the TTL but never the budget. */
  async getProfile(
    identity: ProfileIdentity,
    name: string,
    refresh: boolean,
  ): Promise<ProfileResult> {
    const lower = name.toLowerCase();
    const result = await this.#coalescedLoad(identity, name, refresh);
    if (result.status !== "ok") {
      return result;
    }
    const [profile, note] = await Promise.all([
      this.#resolve(result.payload),
      this.#recordViewAndGetNote(identity.id, lower, result.canonical),
    ]);
    return {
      status: "ok",
      profile,
      fetchedAt: result.fetchedAt,
      stale: result.stale,
      budgetExhausted: result.budgetExhausted,
      note,
    };
  }

  /** One payload load per character at a time; joiners share the result.
   * A joiner's refresh flag is satisfied either way: an in-flight load
   * only exists when it is already deciding against the cache/upstream. */
  #coalescedLoad(
    identity: ProfileIdentity,
    name: string,
    refresh: boolean,
  ): Promise<PayloadResult> {
    const lower = name.toLowerCase();
    let load = this.#profileLoads.get(lower);
    if (!load) {
      load = this.#loadPayload(identity, lower, name, refresh).finally(() => {
        this.#profileLoads.delete(lower);
      });
      this.#profileLoads.set(lower, load);
    }
    return load;
  }

  /** The character-scoped half: cache read → budget → upstream → cache
   * write. No per-identity effects — those stay with each caller. */
  async #loadPayload(
    identity: ProfileIdentity,
    lower: string,
    name: string,
    refresh: boolean,
  ): Promise<PayloadResult> {
    const [cached] = await this.#db
      .select()
      .from(characterCache)
      .where(eq(characterCache.characterLower, lower))
      .limit(1);

    const age = cached
      ? this.#now() - cached.fetchedAt.getTime()
      : Number.POSITIVE_INFINITY;
    const fresh = cached !== undefined && age < this.#cacheTtlMs && !refresh;

    let payload = cached?.payload as CharacterData | undefined;
    let fetchedAt = cached?.fetchedAt.getTime() ?? 0;
    let stale = false;
    let budgetExhausted = false;

    if (!fresh) {
      if (!this.#budget.tryConsume()) {
        if (!cached) {
          return {
            status: "budget-exhausted",
            retryAfterSeconds: Math.ceil(this.#budget.retryAfterMs() / 1000),
          };
        }
        stale = true;
        budgetExhausted = true;
      } else {
        const result = await this.#fetchCharacter(identity, name);
        if (result.status === "ok") {
          payload = result.payload;
          fetchedAt = this.#now();
        } else if (result.status === "not-found") {
          return { status: "not-found", error: result.error };
        } else if (cached) {
          // Upstream trouble with a cache in hand: serve stale, log why.
          this.#log.warn(
            { character: lower, error: result.error },
            "profile refresh failed; serving stale cache",
          );
          stale = true;
        } else {
          throw new Error(result.error);
        }
      }
    }

    if (!payload) {
      // Unreachable: every branch either returned or set payload from
      // cache/fetch — this guards the type, not a real path.
      throw new Error("profile cache invariant violated");
    }

    const canonical = payload.name ?? name;
    if (!fresh && !stale) {
      await this.#db
        .insert(characterCache)
        .values({
          characterLower: lower,
          characterName: canonical,
          payload: payload as Record<string, unknown>,
          fetchedAt: new Date(fetchedAt),
        })
        .onConflictDoUpdate({
          target: characterCache.characterLower,
          set: {
            characterName: canonical,
            payload: payload,
            fetchedAt: new Date(fetchedAt),
          },
        });
    }

    return {
      status: "ok",
      payload,
      canonical,
      fetchedAt,
      stale,
      budgetExhausted,
    };
  }

  async history(
    identityId: string,
    limit: number,
    before?: number,
  ): Promise<ProfileHistoryEntry[]> {
    const conditions = [eq(profileViews.identityId, identityId)];
    if (before !== undefined) {
      conditions.push(lt(profileViews.lastViewedAt, new Date(before)));
    }
    const rows = await this.#db
      .select()
      .from(profileViews)
      .where(and(...conditions))
      .orderBy(desc(profileViews.lastViewedAt))
      .limit(limit);
    return rows.map((row) => ({
      name: row.characterName,
      firstViewedAt: row.firstViewedAt.getTime(),
      lastViewedAt: row.lastViewedAt.getTime(),
      viewCount: row.viewCount,
    }));
  }

  async deleteHistory(identityId: string, name: string): Promise<boolean> {
    const deleted = await this.#db
      .delete(profileViews)
      .where(
        and(
          eq(profileViews.identityId, identityId),
          eq(profileViews.characterLower, name.toLowerCase()),
        ),
      )
      .returning({ name: profileViews.characterLower });
    return deleted.length > 0;
  }

  async getNote(identityId: string, name: string): Promise<string | null> {
    const [row] = await this.#db
      .select({ note: characterNotes.note })
      .from(characterNotes)
      .where(
        and(
          eq(characterNotes.identityId, identityId),
          eq(characterNotes.characterLower, name.toLowerCase()),
        ),
      )
      .limit(1);
    return row?.note ?? null;
  }

  /** Empty note = delete the row (the UI's "clear" is not a tombstone). */
  async putNote(identityId: string, name: string, note: string): Promise<void> {
    const lower = name.toLowerCase();
    if (note === "") {
      await this.#db
        .delete(characterNotes)
        .where(
          and(
            eq(characterNotes.identityId, identityId),
            eq(characterNotes.characterLower, lower),
          ),
        );
      return;
    }
    await this.#db
      .insert(characterNotes)
      .values({ identityId, characterLower: lower, note })
      .onConflictDoUpdate({
        target: [characterNotes.identityId, characterNotes.characterLower],
        set: { note, updatedAt: new Date(this.#now()) },
      });
  }

  /** Budget-counted guestbook page, gated on the cached profile's
   * settings.guestbook so disabled guestbooks never spend budget. */
  async guestbook(
    identity: ProfileIdentity,
    name: string,
    page: number,
  ): Promise<GuestbookResult> {
    // The payload path directly, NOT getProfile: paging a guestbook must
    // not bump the view history / timesViewed once per page (M8 audit).
    const loaded = await this.#coalescedLoad(identity, name, false);
    if (loaded.status === "budget-exhausted") {
      return loaded;
    }
    if (loaded.status === "not-found") {
      return { status: "upstream-error", error: loaded.error };
    }
    const resolved = await this.#resolve(loaded.payload);
    if (!resolved.settings.guestbook) {
      return { status: "no-guestbook" };
    }
    if (!this.#budget.tryConsume()) {
      return {
        status: "budget-exhausted",
        retryAfterSeconds: Math.ceil(this.#budget.retryAfterMs() / 1000),
      };
    }
    const result = await withTicket(this.#tickets, identity, (auth) =>
      this.#api.guestbook(auth, resolved.id, page),
    );
    if (result.error !== "") {
      return result.error.includes("does not have a guestbook")
        ? { status: "no-guestbook" }
        : { status: "upstream-error", error: result.error };
    }
    return {
      status: "ok",
      page: {
        posts: (result.posts ?? []).map((post) => ({
          id: post.id,
          character: post.character.name,
          postedAt: post.postedAt ?? null,
          message: post.message ?? "",
          reply: post.reply ?? null,
        })),
        page,
        nextPage: result.nextPage ?? false,
      },
    };
  }

  /** F-List memo for the note-import affordance. Budget-free (not a
   * character-data-class request). */
  async memo(
    identity: ProfileIdentity,
    name: string,
  ): Promise<
    { note: string | null } | { status: "upstream-error"; error: string }
  > {
    const result = await withTicket(this.#tickets, identity, (auth) =>
      this.#api.memoGet(auth, name),
    );
    if (result.error !== "") {
      return { status: "upstream-error", error: result.error };
    }
    return { note: result.note ?? null };
  }

  /** Relationship stats from the bouncer's own data — SQL over the
   * identity's messages + the view-history row + live session state.
   * Zero F-List traffic. */
  async insights(identityId: string, name: string): Promise<ProfileInsights> {
    const lower = name.toLowerCase();

    // DM thread with this character (partner matching is case-insensitive,
    // same rule as the conversations unique index).
    const [dm] = await this.#db
      .select({
        sent: sql<number>`count(*) filter (where ${messages.sentByUs})`,
        received: sql<number>`count(*) filter (where not ${messages.sentByUs})`,
        lastAt: sql<Date | null>`max(${messages.createdAt})`,
      })
      .from(messages)
      .innerJoin(conversations, eq(messages.conversationId, conversations.id))
      .where(
        and(
          eq(conversations.identityId, identityId),
          eq(conversations.kind, "pm"),
          sql`lower(${conversations.partnerCharacter}) = ${lower}`,
        ),
      );

    // Anything we ever observed them say, in any of this identity's
    // conversations (channels included).
    const [observed] = await this.#db
      .select({
        firstAt: sql<Date | null>`min(${messages.createdAt})`,
        lastAt: sql<Date | null>`max(${messages.createdAt})`,
      })
      .from(messages)
      .innerJoin(conversations, eq(messages.conversationId, conversations.id))
      .where(
        and(
          eq(conversations.identityId, identityId),
          sql`lower(${messages.senderCharacter}) = ${lower}`,
          sql`not ${messages.sentByUs}`,
        ),
      );

    // Where that first encounter happened (cheap second lookup, only when
    // there was one).
    let firstEncountered: ProfileInsights["firstEncountered"] = null;
    if (observed?.firstAt) {
      const [row] = await this.#db
        .select({ title: conversations.title })
        .from(messages)
        .innerJoin(conversations, eq(messages.conversationId, conversations.id))
        .where(
          and(
            eq(conversations.identityId, identityId),
            sql`lower(${messages.senderCharacter}) = ${lower}`,
            sql`not ${messages.sentByUs}`,
          ),
        )
        .orderBy(messages.id)
        .limit(1);
      firstEncountered = {
        at: new Date(observed.firstAt).getTime(),
        conversation: row?.title ?? "",
      };
    }

    const [view] = await this.#db
      .select()
      .from(profileViews)
      .where(
        and(
          eq(profileViews.identityId, identityId),
          eq(profileViews.characterLower, lower),
        ),
      )
      .limit(1);

    // Live state: empty/offline when the identity is detached.
    const state = this.#sessions.get(identityId)?.state;
    const presence = state
      ? [...state.characters.entries()].find(
          ([character]) => character.toLowerCase() === lower,
        )?.[1]
      : undefined;
    const sharedChannels = state
      ? [...state.channels.values()]
          .filter((channel) =>
            [...channel.members].some(
              (member) => member.toLowerCase() === lower,
            ),
          )
          .map((channel) => channel.title)
      : [];

    return {
      messagesSent: Number(dm?.sent ?? 0),
      messagesReceived: Number(dm?.received ?? 0),
      lastChattedAt: dm?.lastAt ? new Date(dm.lastAt).getTime() : null,
      firstEncountered,
      lastSeenTalkingAt: observed?.lastAt
        ? new Date(observed.lastAt).getTime()
        : null,
      online: presence !== undefined,
      status: presence?.status ?? null,
      sharedChannels,
      timesViewed: view?.viewCount ?? 0,
      firstViewedAt: view?.firstViewedAt.getTime() ?? null,
    };
  }

  async #fetchCharacter(
    identity: ProfileIdentity,
    name: string,
  ): Promise<
    | { status: "ok"; payload: CharacterData }
    | { status: "not-found"; error: string }
    | { status: "upstream-error"; error: string }
  > {
    let raw;
    try {
      raw = await withTicket(this.#tickets, identity, (auth) =>
        this.#api.characterData(auth, name),
      );
    } catch (error) {
      // Lock/busy conditions keep their type — the route maps them to
      // 409/503; a stale cache must not paper over "please unlock".
      if (
        error instanceof AccountLockedError ||
        error instanceof FlistApiBusyError
      ) {
        throw error;
      }
      return {
        status: "upstream-error",
        error: error instanceof Error ? error.message : "F-List API error",
      };
    }
    const payload = characterDataSchema.parse(raw);
    if (payload.error !== "") {
      return /not found/i.test(payload.error)
        ? { status: "not-found", error: payload.error }
        : { status: "upstream-error", error: payload.error };
    }
    return { status: "ok", payload };
  }

  async #recordViewAndGetNote(
    identityId: string,
    lower: string,
    canonical: string,
  ): Promise<string | null> {
    const at = new Date(this.#now());
    await this.#db
      .insert(profileViews)
      .values({
        identityId,
        characterLower: lower,
        characterName: canonical,
        firstViewedAt: at,
        lastViewedAt: at,
      })
      .onConflictDoUpdate({
        target: [profileViews.identityId, profileViews.characterLower],
        set: {
          characterName: canonical,
          lastViewedAt: at,
          viewCount: sql`${profileViews.viewCount} + 1`,
        },
      });
    return this.getNote(identityId, lower);
  }

  /** The bulk mapping payload, DB-cached (~7 days) with an in-memory memo.
   * Concurrent refreshes coalesce onto one upstream call. */
  /**
   * The F-List kink vocabulary — id (as the string the FKS wire wants),
   * name, group — off the cached mapping list (M10 search picker).
   */
  async kinkVocabulary(): Promise<
    { id: string; name: string; group?: string }[]
  > {
    const mappings = await this.#getMappings();
    const groups = new Map(
      (mappings.kink_groups ?? []).map((group) => [group.id, group.name]),
    );
    return (mappings.kinks ?? []).map((kink) => {
      const group = groups.get(kink.group_id);
      return {
        id: String(kink.id),
        name: kink.name,
        ...(group !== undefined ? { group } : {}),
      };
    });
  }

  async #getMappings(): Promise<MappingList> {
    if (
      this.#mappings &&
      this.#now() - this.#mappings.fetchedAt < this.#mappingsTtlMs
    ) {
      return this.#mappings.data;
    }
    const [row] = await this.#db
      .select()
      .from(flistMappings)
      .where(eq(flistMappings.source, "mapping-list"))
      .limit(1);
    if (row && this.#now() - row.fetchedAt.getTime() < this.#mappingsTtlMs) {
      const data = mappingListSchema.parse(row.payload);
      this.#mappings = { data, fetchedAt: row.fetchedAt.getTime() };
      return data;
    }
    this.#mappingsRefresh ??= this.#refreshMappings(row !== undefined).finally(
      () => {
        this.#mappingsRefresh = undefined;
      },
    );
    return this.#mappingsRefresh;
  }

  async #refreshMappings(haveStale: boolean): Promise<MappingList> {
    try {
      const data = mappingListSchema.parse(await this.#api.mappingList());
      if (data.error !== "") {
        throw new Error(data.error);
      }
      const fetchedAt = new Date(this.#now());
      await this.#db
        .insert(flistMappings)
        .values({
          source: "mapping-list",
          payload: data as Record<string, unknown>,
          fetchedAt,
        })
        .onConflictDoUpdate({
          target: flistMappings.source,
          set: { payload: data, fetchedAt },
        });
      this.#mappings = { data, fetchedAt: fetchedAt.getTime() };
      return data;
    } catch (error) {
      // A stale mapping set still resolves profiles; only a cold start
      // without any payload is fatal.
      if (haveStale || this.#mappings) {
        this.#log.warn({ err: error }, "mapping-list refresh failed");
        if (this.#mappings) {
          return this.#mappings.data;
        }
        const [row] = await this.#db
          .select()
          .from(flistMappings)
          .where(eq(flistMappings.source, "mapping-list"))
          .limit(1);
        if (row) {
          const data = mappingListSchema.parse(row.payload);
          this.#mappings = { data, fetchedAt: row.fetchedAt.getTime() };
          return data;
        }
      }
      throw error;
    }
  }

  /** Raw payload → ProfileDto: infotags resolved through the mapping lists
   * (list-type values via listitems), kinks through the kink table, images
   * into assembled URLs. Unknown ids are skipped, not fatal — mapping drift
   * must never break a profile view. */
  async #resolve(payload: CharacterData): Promise<ProfileDto> {
    const mappings = await this.#getMappings();
    const infotagById = new Map(
      (mappings.infotags ?? []).map((tag) => [tag.id, tag]),
    );
    const groupById = new Map(
      (mappings.infotag_groups ?? []).map((group) => [group.id, group.name]),
    );
    const listitemById = new Map(
      (mappings.listitems ?? []).map((item) => [item.id, item]),
    );
    const kinkById = new Map(
      (mappings.kinks ?? []).map((kink) => [kink.id, kink]),
    );

    const groups = new Map<
      string,
      { id: number; label: string; value: string }[]
    >();
    for (const [idRaw, valueRaw] of Object.entries(payload.infotags ?? {})) {
      const id = Number(idRaw);
      const tag = infotagById.get(id);
      if (!tag) {
        continue;
      }
      const value =
        tag.type === "list"
          ? (listitemById.get(Number(valueRaw))?.value ?? valueRaw)
          : valueRaw;
      const groupName = groupById.get(tag.group_id) ?? "Other";
      const bucket = groups.get(groupName) ?? [];
      bucket.push({ id, label: tag.name, value });
      groups.set(groupName, bucket);
    }

    const kinks = [];
    for (const [idRaw, choice] of Object.entries(payload.kinks ?? {})) {
      if (!KINK_CHOICES.has(choice)) {
        continue;
      }
      const id = Number(idRaw);
      const kink = kinkById.get(id);
      if (!kink) {
        continue;
      }
      kinks.push({
        id,
        name: kink.name,
        description: kink.description ?? "",
        choice: choice as "fave" | "yes" | "maybe" | "no",
      });
    }

    return {
      id: payload.id ?? 0,
      name: payload.name ?? "",
      description: payload.description ?? "",
      views: payload.views ?? 0,
      customTitle:
        payload.custom_title === "" ? null : (payload.custom_title ?? null),
      customsFirst: payload.customs_first ?? false,
      createdAt: payload.created_at ?? null,
      updatedAt: payload.updated_at ?? null,
      settings: {
        guestbook: payload.settings?.guestbook ?? false,
        showFriends: payload.settings?.show_friends ?? false,
        preventBookmarks: payload.settings?.prevent_bookmarks ?? false,
        public: payload.settings?.public ?? true,
      },
      badges: payload.badges ?? [],
      infotagGroups: [...groups.entries()].map(([group, tags]) => ({
        group,
        tags,
      })),
      kinks,
      customKinks: Object.values(payload.custom_kinks ?? {}).map((custom) => ({
        name: custom.name,
        description: custom.description ?? "",
        choice: custom.choice ?? "yes",
        children: custom.children ?? [],
      })),
      images: (payload.images ?? []).map((image) => ({
        id: image.image_id,
        // The extension is an unconstrained upstream string headed into a
        // URL — keep it to a plain file suffix (audit L: defense in depth;
        // the host is fixed either way).
        url: `${IMAGE_BASE}/${String(image.image_id)}.${
          /^[a-zA-Z0-9]{1,5}$/.test(image.extension) ? image.extension : "jpg"
        }`,
        width: image.width ?? null,
        height: image.height ?? null,
        description: image.description ?? "",
      })),
      inlines: Object.fromEntries(
        Object.entries(payload.inlines ?? {}).flatMap(([id, inline]) => {
          // The hash is the sharded path; keep it hex so a hostile value
          // can't escape the fixed static.f-list.net host (audit L: defense
          // in depth). The extension stays a plain file suffix.
          if (!/^[a-f0-9]{4,}$/i.test(inline.hash)) {
            return [];
          }
          const ext = /^[a-zA-Z0-9]{1,5}$/.test(inline.extension)
            ? inline.extension
            : "jpg";
          const url = `${INLINE_BASE}/${inline.hash.slice(0, 2)}/${inline.hash.slice(2, 4)}/${inline.hash}.${ext}`;
          return [[id, { url }]];
        }),
      ),
      timezone: payload.timezone ?? null,
    };
  }
}
