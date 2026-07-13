// Database schema (design/architecture.md §Database schema). Column names map
// to snake_case via drizzle's `casing` option — keep it set in both
// drizzle.config.ts and createDb().
//
// M4–M6 tables (highlight_rules, user_preferences, channel_directory,
// email_tokens) arrive with their milestones; outbox_messages exists from day
// one per the architecture.

import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  index,
  integer,
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
  emailVerifiedAt: timestamp({ withTimezone: true }),
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
    releaseAt: timestamp({ withTimezone: true }).notNull(),
    /** "scheduled" | "failed" (release send refused). */
    state: text().notNull().default("scheduled"),
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
  updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
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
