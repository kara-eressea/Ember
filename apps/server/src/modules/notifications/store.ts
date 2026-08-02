// Notification inbox (#466) — the durable half of "things that wanted your
// attention": mentions the history sink stamped, plus the three website RTB
// events (friend requests, notes, comment replies) that used to flash past
// as transient notices and vanish.
//
// It is a LOG, not a to-do list: rows persist after they are read. "Seen" is
// a per-identity watermark over notifications.id (notification_seen), so
// marking the inbox read is one write however deep the log is, and a row
// never mutates after insert.
//
// Muted mentions are logged but never badged — mutes silence alerts
// (decisions.md §10), the same rule the favicon indicator follows. The
// verdict is stamped at write time and immutable, exactly like
// messages.mention: a mute added later does not rewrite history.

import { and, desc, eq, gt, lt, sql } from "drizzle-orm";
import {
  resolvePrefs,
  type NotificationDto,
  type NotificationKind,
} from "@emberchat/protocol";
import type { Db } from "../../db/index.js";
import {
  flistAccounts,
  identities,
  notifications,
  notificationSeen,
  userPreferences,
} from "../../db/schema.js";
import { TypedEventBus } from "../session-engine/event-bus.js";
import type { SessionLogger } from "../session-engine/fchat-session.js";

export type NotificationRow = typeof notifications.$inferSelect;

export interface NotificationEvents {
  /** A row was appended to an identity's inbox. */
  notification: { identityId: string; notification: NotificationRow };
}

/** Rows kept per identity; the oldest beyond this are pruned on insert. */
export const MAX_NOTIFICATIONS_PER_IDENTITY = 500;

/**
 * Inserts between prune passes. Pruning every insert would add a keyset
 * probe to every mention on a busy channel for a table that only overflows
 * once every few hundred rows, so it runs on a counter — the cap is a
 * ceiling on growth, not an exact row budget.
 */
export const PRUNE_EVERY = 50;

/** Excerpt length stored per row — a list-row preview, not the message. */
export const EXCERPT_MAX = 160;

/** Unseen counts are capped like the badge totals; the client renders 99+. */
export const UNSEEN_CAP = 99;

/** Strip BBCode for the stored excerpt. Mirrors the client's previewText:
 * the wire grammar is `[name]`/`[name=arg]`/`[/name]`, so a bracket strip is
 * exact for well-formed content and merely cosmetic for anything else. */
export function excerptOf(bbcode: string, maxLength = EXCERPT_MAX): string {
  const text = bbcode
    .replace(/\[[^\]]*\]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

export function notificationDto(row: NotificationRow): NotificationDto {
  return {
    id: row.id,
    kind: row.kind,
    ...(row.conversationId !== null ? { convId: row.conversationId } : {}),
    ...(row.messageId !== null ? { messageId: row.messageId } : {}),
    character: row.character,
    excerpt: row.excerpt,
    muted: row.muted,
    createdAt: row.createdAt.toISOString(),
  };
}

export class NotificationStore {
  readonly events: TypedEventBus<NotificationEvents>;

  readonly #db: Db;
  readonly #log: SessionLogger | undefined;
  readonly #maxPerIdentity: number;
  /** identity → user is immutable (identities never move accounts). */
  readonly #userByIdentity = new Map<string, string>();
  /** Per-user mute lists, dropped by invalidatePrefs on a prefs patch. */
  readonly #mutesByUser = new Map<
    string,
    { identities: Set<string>; conversations: Set<string> }
  >();
  /** Inserts since each identity's last prune pass. */
  readonly #sincePrune = new Map<string, number>();

  constructor(
    db: Db,
    logger?: SessionLogger,
    options: { maxPerIdentity?: number } = {},
  ) {
    this.#db = db;
    this.#log = logger;
    this.#maxPerIdentity =
      options.maxPerIdentity ?? MAX_NOTIFICATIONS_PER_IDENTITY;
    this.events = new TypedEventBus<NotificationEvents>(logger);
  }

  /** Drop cached mute lists after a prefs patch (mirrors HighlightMatcher). */
  invalidatePrefs(userId: string): void {
    this.#mutesByUser.delete(userId);
  }

  /**
   * A mention the sink just stamped. Called from inside the sink's per-identity
   * serial task, so inbox ids follow message ids in arrival order. Never
   * throws: an inbox failure must not take the history write with it.
   */
  async recordMention(entry: {
    identityId: string;
    conversationId: string;
    messageId: number;
    senderCharacter: string;
    bbcode: string;
  }): Promise<NotificationRow | undefined> {
    return this.#insert({
      identityId: entry.identityId,
      kind: "mention",
      conversationId: entry.conversationId,
      messageId: entry.messageId,
      character: entry.senderCharacter,
      excerpt: excerptOf(entry.bbcode),
      muted: await this.#isMuted(entry.identityId, entry.conversationId),
    });
  }

  /**
   * A website event bridged over the chat socket. Only the three kinds with
   * a place to go are logged — everything else RTB carries stays the
   * transient notice it always was.
   */
  async recordRtb(
    identityId: string,
    kind: Exclude<NotificationKind, "mention">,
    character: string,
    subject?: string,
  ): Promise<NotificationRow | undefined> {
    return this.#insert({
      identityId,
      kind,
      conversationId: null,
      messageId: null,
      character,
      excerpt: subject === undefined ? "" : excerptOf(subject),
      // RTB events are account-level: a muted conversation says nothing
      // about them, and a muted identity's own alerts stay silenced.
      muted: await this.#isMuted(identityId),
    });
  }

  async #insert(values: {
    identityId: string;
    kind: NotificationKind;
    conversationId: string | null;
    messageId: number | null;
    character: string;
    excerpt: string;
    muted: boolean;
  }): Promise<NotificationRow | undefined> {
    try {
      const [row] = await this.#db
        .insert(notifications)
        .values(values)
        .returning();
      if (!row) {
        return undefined;
      }
      this.events.emit("notification", {
        identityId: values.identityId,
        notification: row,
      });
      await this.#maybePrune(values.identityId);
      return row;
    } catch (error) {
      this.#log?.error({ err: error }, "notification write failed");
      return undefined;
    }
  }

  /** One keyset page, newest first. `before` walks toward older rows. */
  async list(
    identityId: string,
    options: { before?: number; limit: number },
  ): Promise<{ rows: NotificationRow[]; hasMore: boolean }> {
    const page = await this.#db
      .select()
      .from(notifications)
      .where(
        and(
          eq(notifications.identityId, identityId),
          options.before === undefined
            ? undefined
            : lt(notifications.id, options.before),
        ),
      )
      .orderBy(desc(notifications.id))
      .limit(options.limit + 1);
    return {
      rows: page.slice(0, options.limit),
      hasMore: page.length > options.limit,
    };
  }

  /** The identity's seen watermark; 0 when nothing has been seen. */
  async lastSeenId(identityId: string): Promise<number> {
    const [row] = await this.#db
      .select({ lastSeenId: notificationSeen.lastSeenId })
      .from(notificationSeen)
      .where(eq(notificationSeen.identityId, identityId))
      .limit(1);
    return row?.lastSeenId ?? 0;
  }

  /**
   * Advances the watermark, monotonically — a stale mark from a lagging tab
   * (or a device whose page predates newer rows) never uncovers rows the
   * user has already been shown. Returns the resulting watermark.
   */
  async markSeen(identityId: string, lastSeenId: number): Promise<number> {
    const [row] = await this.#db
      .insert(notificationSeen)
      .values({ identityId, lastSeenId })
      .onConflictDoUpdate({
        target: notificationSeen.identityId,
        set: {
          lastSeenId: sql`greatest(${notificationSeen.lastSeenId}, ${lastSeenId})`,
          updatedAt: new Date(),
        },
      })
      .returning({ lastSeenId: notificationSeen.lastSeenId });
    return row?.lastSeenId ?? lastSeenId;
  }

  /**
   * Rows past the watermark that are allowed to badge — muted ones are
   * logged but never counted (decisions.md §10). Capped: the count walks the
   * (identity_id, id desc) index and stops at UNSEEN_CAP, so a neglected
   * inbox costs the same as a fresh one.
   */
  async unseenCount(identityId: string): Promise<number> {
    const watermark = await this.lastSeenId(identityId);
    const [row] = await this.#db
      .select({ total: sql<number>`count(*)::int` })
      .from(
        this.#db
          .select({ id: notifications.id })
          .from(notifications)
          .where(
            and(
              eq(notifications.identityId, identityId),
              gt(notifications.id, watermark),
              eq(notifications.muted, false),
            ),
          )
          .orderBy(desc(notifications.id))
          .limit(UNSEEN_CAP)
          .as("capped"),
      );
    return row?.total ?? 0;
  }

  /**
   * Keeps the newest `maxPerIdentity` rows. Opportunistic: one keyset probe
   * for the cut id, then a bounded delete. The retention sweep needs no
   * companion pass — mention rows cascade from messages/conversations.
   */
  async #maybePrune(identityId: string): Promise<void> {
    const since = (this.#sincePrune.get(identityId) ?? 0) + 1;
    if (since < PRUNE_EVERY) {
      this.#sincePrune.set(identityId, since);
      return;
    }
    this.#sincePrune.set(identityId, 0);
    await this.prune(identityId);
  }

  /** Trim one identity's inbox to the cap; returns how many rows went. */
  async prune(identityId: string): Promise<number> {
    const [cut] = await this.#db
      .select({ id: notifications.id })
      .from(notifications)
      .where(eq(notifications.identityId, identityId))
      .orderBy(desc(notifications.id))
      .limit(1)
      .offset(this.#maxPerIdentity);
    if (!cut) {
      return 0;
    }
    const deleted = await this.#db
      .delete(notifications)
      .where(
        and(
          eq(notifications.identityId, identityId),
          sql`${notifications.id} <= ${cut.id}`,
        ),
      )
      .returning({ id: notifications.id });
    return deleted.length;
  }

  /**
   * Does the user's mute state silence alerts for this identity (and, for a
   * mention, this conversation)? Read through a per-user cache invalidated
   * by prefs patches; a lookup failure resolves to "not muted" so an inbox
   * row is never silently downgraded by a database hiccup.
   */
  async #isMuted(
    identityId: string,
    conversationId?: string,
  ): Promise<boolean> {
    try {
      const userId = await this.#userId(identityId);
      if (userId === undefined) {
        return false;
      }
      const mutes = await this.#mutes(userId);
      return (
        mutes.identities.has(identityId) ||
        (conversationId !== undefined &&
          mutes.conversations.has(conversationId))
      );
    } catch (error) {
      this.#log?.warn({ err: error }, "notification mute lookup failed");
      return false;
    }
  }

  async #userId(identityId: string): Promise<string | undefined> {
    const cached = this.#userByIdentity.get(identityId);
    if (cached !== undefined) {
      return cached;
    }
    const [row] = await this.#db
      .select({ userId: flistAccounts.userId })
      .from(identities)
      .innerJoin(flistAccounts, eq(identities.flistAccountId, flistAccounts.id))
      .where(eq(identities.id, identityId))
      .limit(1);
    if (row) {
      this.#userByIdentity.set(identityId, row.userId);
    }
    return row?.userId;
  }

  async #mutes(
    userId: string,
  ): Promise<{ identities: Set<string>; conversations: Set<string> }> {
    const cached = this.#mutesByUser.get(userId);
    if (cached !== undefined) {
      return cached;
    }
    const [row] = await this.#db
      .select({ prefs: userPreferences.prefs })
      .from(userPreferences)
      .where(eq(userPreferences.userId, userId))
      .limit(1);
    const prefs = resolvePrefs(row?.prefs);
    const mutes = {
      identities: new Set(prefs.mutedIdentityIds),
      conversations: new Set(prefs.mutedConvIds),
    };
    this.#mutesByUser.set(userId, mutes);
    return mutes;
  }
}
