// Database schema (design/architecture.md §Database schema). Column names map
// to snake_case via drizzle's `casing` option — keep it set in both
// drizzle.config.ts and createDb().

import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

// Postgres 18 ships uuidv7() natively — time-ordered ids, kind to btrees.
const uuidv7 = sql`uuidv7()`;

export const appUsers = pgTable("app_users", {
  id: uuid().primaryKey().default(uuidv7),
  email: text().notNull().unique(),
  username: text().notNull().unique(),
  passwordHash: text().notNull(),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

export const authSessions = pgTable("auth_sessions", {
  id: uuid().primaryKey().default(uuidv7),
  userId: uuid()
    .notNull()
    .references(() => appUsers.id, { onDelete: "cascade" }),
  refreshTokenHash: text().notNull().unique(),
  deviceLabel: text(),
  expiresAt: timestamp({ withTimezone: true }).notNull(),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

// No secrets here — F-List credentials live only in the in-memory vault
// (decisions.md §3).
export const flistAccounts = pgTable(
  "flist_accounts",
  {
    id: uuid().primaryKey().default(uuidv7),
    userId: uuid()
      .notNull()
      .references(() => appUsers.id, { onDelete: "cascade" }),
    accountName: text().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("flist_accounts_user_account_uniq").on(t.userId, t.accountName),
  ],
);

/**
 * Opt-in at-rest F-List credentials (M9, decisions.md §15): one row per
 * account that chose "Remember on this server". The ciphertext is
 * AES-256-GCM under the env-file CREDENTIALS_KEY — the key never enters
 * the database, so dumps/backups alone stay ciphertext. Its own table,
 * never a column on flist_accounts: backup and pruning stories stay
 * independent, and dropping the feature is dropping the table.
 */
export const flistCredentials = pgTable("flist_credentials", {
  accountId: uuid()
    .primaryKey()
    .references(() => flistAccounts.id, { onDelete: "cascade" }),
  /** base64(iv ‖ auth tag ‖ ciphertext). */
  ciphertext: text().notNull(),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

export const identities = pgTable(
  "identities",
  {
    id: uuid().primaryKey().default(uuidv7),
    flistAccountId: uuid()
      .notNull()
      .references(() => flistAccounts.id, { onDelete: "cascade" }),
    characterName: text().notNull(),
    /** Connect automatically once the account's vault is unlocked. */
    autoConnect: boolean().notNull().default(false),
    /** When the identity last went subscriber-less (null = attached, or
     * never detached). Persisted so the detached-disconnect ceiling and
     * boot-time session resume count across restarts (decisions.md §15). */
    lastDetachedAt: timestamp({ withTimezone: true }),
    sortOrder: integer().notNull().default(0),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("identities_account_character_uniq").on(
      t.flistAccountId,
      t.characterName,
    ),
  ],
);

export const conversationKind = pgEnum("conversation_kind", ["channel", "pm"]);
export const messageKind = pgEnum("message_kind", [
  "msg",
  "lrp",
  "rll",
  "sys",
  "pm",
]);

export const conversations = pgTable(
  "conversations",
  {
    id: uuid().primaryKey().default(uuidv7),
    identityId: uuid()
      .notNull()
      .references(() => identities.id, { onDelete: "cascade" }),
    kind: conversationKind().notNull(),
    /** F-Chat channel name or ADH- id; null for PMs. */
    channelKey: text(),
    /** PM partner character; null for channels. */
    partnerCharacter: text(),
    title: text().notNull(),
    pinned: boolean().notNull().default(false),
    joined: boolean().notNull().default(false),
    /** Cursor into messages.id; not a FK so retention can trim messages freely. */
    lastReadMessageId: bigint({ mode: "number" }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Channel keys are exact (ADH ids are case-sensitive); PM partners are
    // case-insensitive — F-Chat resolves PRI recipients regardless of casing,
    // so "nyx" and "Nyx" must be one thread.
    uniqueIndex("conversations_identity_channel_uniq")
      .on(t.identityId, t.channelKey)
      .where(sql`kind = 'channel'`),
    uniqueIndex("conversations_identity_partner_uniq")
      .on(t.identityId, sql`lower(${t.partnerCharacter})`)
      .where(sql`kind = 'pm'`),
  ],
);

export const messages = pgTable(
  "messages",
  {
    /** bigserial — doubles as the gateway resume cursor. */
    id: bigserial({ mode: "number" }).primaryKey(),
    conversationId: uuid()
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    senderCharacter: text().notNull(),
    kind: messageKind().notNull(),
    bbcode: text().notNull(),
    sourceMarkdown: text(),
    sentByUs: boolean().notNull().default(false),
    /** Highlight-matcher verdict, stamped at persist time (M5). Immutable —
     * rule changes affect new messages only (decisions.md §10). */
    mention: boolean().notNull().default(false),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  // Pagination, unread counts, catch-up replay.
  (t) => [
    index("messages_conversation_id_idx").on(t.conversationId, t.id.desc()),
  ],
);

// Delayed-send queue. Rows live only while pending: released and recalled
// messages are deleted (the messages table holds what actually went out).
// A row that could not be sent at release keeps state="failed" so the user
// can see what never left.
export const outboxMessages = pgTable(
  "outbox_messages",
  {
    id: uuid().primaryKey().default(uuidv7),
    identityId: uuid()
      .notNull()
      .references(() => identities.id, { onDelete: "cascade" }),
    conversationId: uuid()
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    markdown: text().notNull(),
    bbcode: text().notNull(),
    /** What the release puts on the wire: "msg" (or "pm" — the conversation
     * kind decides) or "lrp" for a delayed roleplay ad (M6). */
    kind: messageKind().notNull().default("msg"),
    releaseAt: timestamp({ withTimezone: true }).notNull(),
    /** "scheduled" | "releasing" (claimed by the worker — no longer
     * recallable) | "failed" (release refused; failureReason says why). */
    state: text().notNull().default("scheduled"),
    failureReason: text(),
    /** When the row entered "failed" — the failed-row TTL keys on this,
     * not releaseAt: crash-recovery can fail a row long after its release
     * and the user still deserves the full window to see it (M7 audit). */
    failedAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  // The release worker's poll: due scheduled rows in release order.
  (t) => [index("outbox_release_idx").on(t.state, t.releaseAt)],
);

// Per-user behavior preferences (M4+). Absent row = all defaults.
export const userPreferences = pgTable("user_preferences", {
  userId: uuid()
    .primaryKey()
    .references(() => appUsers.id, { onDelete: "cascade" }),
  /** Delayed-send window in seconds; 0 sends immediately. */
  sendDelaySeconds: integer().notNull().default(0),
  /** Sparse prefs patch document (M5) — absent keys mean "default". Kept
   * flat and merged with jsonb `||` so concurrent patches from two devices
   * never clobber each other's keys. Read through `resolvePrefs`. */
  prefs: jsonb().$type<Record<string, unknown>>().notNull().default({}),
  updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

export const highlightRuleKind = pgEnum("highlight_rule_kind", [
  "word",
  "nick",
  "regex",
]);

// Per-user highlight rules (M5) — apply across every identity's log. The
// sink consults them at persist time to stamp messages.mention; regex
// patterns are validated against RE2 at PUT.
export const highlightRules = pgTable(
  "highlight_rules",
  {
    id: uuid().primaryKey().default(uuidv7),
    userId: uuid()
      .notNull()
      .references(() => appUsers.id, { onDelete: "cascade" }),
    kind: highlightRuleKind().notNull(),
    pattern: text().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("highlight_rules_user_kind_pattern_uniq").on(
      t.userId,
      t.kind,
      t.pattern,
    ),
  ],
);

export const channelDirectoryKind = pgEnum("channel_directory_kind", [
  "official",
  "open",
]);

// Server-wide cache of the public channel listings (M6). One F-Chat server,
// one directory — rows are shared across every user and replaced wholesale
// per kind on each CHA/ORS response. Counts are point-in-time; refreshed_at
// lets the client display staleness honestly. Hidden/invite-only rooms never
// appear in listings, so they never appear here either.
export const channelDirectory = pgTable("channel_directory", {
  /** F-Chat channel name (official) or ADH- id (open room). */
  channelKey: text().primaryKey(),
  kind: channelDirectoryKind().notNull(),
  /** Display title; for official channels this equals the key. */
  title: text().notNull(),
  lastSeenCount: integer().notNull().default(0),
  refreshedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

export const ignores = pgTable(
  "ignores",
  {
    identityId: uuid()
      .notNull()
      .references(() => identities.id, { onDelete: "cascade" }),
    character: text().notNull(),
  },
  (t) => [primaryKey({ columns: [t.identityId, t.character] })],
);

// ── Profile service (M8) ─────────────────────────────────────────────────────

// Global character-data payload cache — one row per character, shared across
// every identity so two identities viewing the same character never
// double-spend the 170/hour budget. Rows are refreshed (not deleted) when
// older than the cache TTL; a stale row is still served with a flag when the
// budget is exhausted.
export const characterCache = pgTable("character_cache", {
  characterLower: text().primaryKey(),
  /** Canonical casing as returned by character-data. */
  characterName: text().notNull(),
  /** Raw character-data.php payload (chat-json-endpoints.md "Verified
   * shapes") — resolved into a ProfileDto per request so mapping refreshes
   * never invalidate cached profiles. */
  payload: jsonb().$type<Record<string, unknown>>().notNull(),
  fetchedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

// Per-identity profile-view history — doubles as the user-facing "recently
// viewed" rail. History = row existence: never TTL'd, pruned only by the
// user, synced across devices by construction.
export const profileViews = pgTable(
  "profile_views",
  {
    identityId: uuid()
      .notNull()
      .references(() => identities.id, { onDelete: "cascade" }),
    characterLower: text().notNull(),
    /** Canonical casing, denormalized so the history list never depends on a
     * cache row surviving. */
    characterName: text().notNull(),
    firstViewedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    lastViewedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    viewCount: integer().notNull().default(1),
  },
  (t) => [
    primaryKey({ columns: [t.identityId, t.characterLower] }),
    // The history rail: an identity's views, most recent first.
    index("profile_views_identity_recency_idx").on(
      t.identityId,
      t.lastViewedAt.desc(),
    ),
  ],
);

// Global bulk payloads that resolve character-data ids into names: the three
// mapping lists (~7-day refresh) and, from step 12, the eicon index. One row
// per source, replaced wholesale on refresh.
export const flistMappings = pgTable("flist_mappings", {
  /** "mapping-list" | "kink-list" | "info-list" | "eicon-index". */
  source: text().primaryKey(),
  payload: jsonb().$type<Record<string, unknown>>().notNull(),
  fetchedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

// Private per-identity notes on a character ("what we RP'd last time").
// Deliberately separate from profile_views so pruning history never deletes
// a note.
export const characterNotes = pgTable(
  "character_notes",
  {
    identityId: uuid()
      .notNull()
      .references(() => identities.id, { onDelete: "cascade" }),
    characterLower: text().notNull(),
    note: text().notNull(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.identityId, t.characterLower] })],
);

// Per-identity roleplay-ad library (M10) — the Horizon-faithful shape:
// content + tags + disabled, ordered by sortOrder (array position in the
// PUT). Tags are local campaign selectors; channel targeting is post-time
// state and deliberately never stored here.
export const ads = pgTable(
  "ads",
  {
    id: uuid().primaryKey().default(uuidv7),
    identityId: uuid()
      .notNull()
      .references(() => identities.id, { onDelete: "cascade" }),
    /** Markdown; translated to BBCode at post time. */
    content: text().notNull(),
    tags: jsonb().$type<string[]>().notNull().default([]),
    disabled: boolean().notNull().default(false),
    sortOrder: integer().notNull().default(0),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("ads_identity_idx").on(t.identityId)],
);
