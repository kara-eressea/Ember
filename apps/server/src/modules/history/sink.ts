// History sink — subscribes to a session's event bus and persists MSG/PRI/SYS
// (inbound and our own sends) into conversations/messages. The messages table
// is the gateway resume log (architecture.md §Resume semantics): bigserial
// ids in arrival order are the cursor, so writes go through a serial queue
// per identity — cursor order only matters within a conversation, and a
// conversation belongs to exactly one identity, so identities never queue
// behind each other's traffic.
//
// After every write it emits on its own bus. The gateway fans those out —
// `message.new` events must carry the persisted messages.id, so live fan-out
// happens after (and in the same order as) persistence, never before.

import { and, asc, count, eq, sql } from "drizzle-orm";
import type { Db } from "../../db/index.js";
import { isUniqueViolation } from "../../db/errors.js";
import { conversations, ignores, messages } from "../../db/schema.js";
import {
  TypedEventBus,
  type OutboundMessage,
} from "../session-engine/event-bus.js";
import type {
  FchatSession,
  SessionLogger,
} from "../session-engine/fchat-session.js";
import type { HighlightMatcher } from "../highlights/matcher.js";
import type { ServerCommandPayload } from "@emberchat/fchat-protocol";

type ConversationKind = "channel" | "pm";

export type ConversationRow = typeof conversations.$inferSelect;
export type MessageRow = typeof messages.$inferSelect;

export interface HistoryEvents {
  /** A message was persisted (inbound or our own send). */
  message: { identityId: string; message: MessageRow };
  /** A conversation was created or updated (joined flag, read cursor). */
  conversation: { identityId: string; conversation: ConversationRow };
}

interface ConversationTarget {
  readonly kind: ConversationKind;
  /** Channel key or PM partner (the per-kind unique-index column). */
  readonly key: string;
  /** Cache key when it differs from `key` (lowercased PM partners). */
  readonly cacheKey?: string;
  readonly title: string;
}

const NOOP_LOGGER: SessionLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

/**
 * Ceiling on conversations per identity for *client-initiated* creation
 * (pm.open). Inbound traffic is not capped — F-Chat itself is the throttle
 * there — but a browser looping pm.open must not bloat the table.
 */
export const MAX_CONVERSATIONS_PER_IDENTITY = 1000;

export class ConversationLimitError extends Error {
  constructor() {
    super("Too many conversations for this identity");
    this.name = "ConversationLimitError";
  }
}

export class HistorySink {
  readonly events: TypedEventBus<HistoryEvents>;

  readonly #db: Db;
  readonly #log: SessionLogger;
  readonly #maxConversationsPerIdentity: number;
  /** Stamps messages.mention at persist time (M5); absent = never mention. */
  readonly #highlights: Pick<HighlightMatcher, "mention"> | undefined;
  /** Per-identity serial write queues: message ids must reflect arrival order within an identity. */
  readonly #queues = new Map<string, Promise<void>>();
  /** conversation-row cache, keyed `${identityId}:${kind}:${key}`. */
  readonly #conversationIds = new Map<string, string>();

  constructor(
    db: Db,
    logger?: SessionLogger,
    options: {
      maxConversationsPerIdentity?: number;
      highlights?: Pick<HighlightMatcher, "mention">;
    } = {},
  ) {
    this.#db = db;
    this.#log = logger ?? NOOP_LOGGER;
    this.#maxConversationsPerIdentity =
      options.maxConversationsPerIdentity ?? MAX_CONVERSATIONS_PER_IDENTITY;
    this.#highlights = options.highlights;
    this.events = new TypedEventBus<HistoryEvents>(this.#log);
  }

  /** Subscribes to the session's bus; detaches itself when the session stops. */
  attach(identityId: string, session: FchatSession): void {
    const offCommand = session.events.on("command", (command) => {
      switch (command.cmd) {
        case "MSG":
          this.#enqueueMessage(identityId, {
            target: this.#channelTarget(session, command.payload.channel),
            senderCharacter: command.payload.character,
            kind: "msg",
            bbcode: command.payload.message,
            sentByUs: false,
            // Only inbound channel messages are highlight-matched — DMs are
            // already directed at the user and carry no mention count.
            ownCharacter: session.character,
          });
          return;
        case "LRP":
          this.#enqueueMessage(identityId, {
            target: this.#channelTarget(session, command.payload.channel),
            senderCharacter: command.payload.character,
            kind: "lrp",
            bbcode: command.payload.message,
            sentByUs: false,
            ownCharacter: session.character,
          });
          return;
        case "RLL":
          // The server computes rolls and echoes the RLL to everyone, the
          // roller included — own rolls arrive here, not via "sent".
          this.#enqueueMessage(identityId, {
            target: this.#channelTarget(session, command.payload.channel),
            senderCharacter: command.payload.character,
            kind: "rll",
            bbcode: command.payload.message,
            sentByUs: command.payload.character === session.character,
          });
          return;
        case "PRI":
          this.#enqueueMessage(identityId, {
            target: pmTarget(command.payload.character),
            senderCharacter: command.payload.character,
            kind: "pm",
            bbcode: command.payload.message,
            sentByUs: false,
          });
          return;
        case "SYS": {
          const channel = command.payload.channel;
          if (channel === undefined) {
            // Global server notices have no conversation to live in; the
            // gateway surfaces them transiently straight off the session bus.
            return;
          }
          this.#enqueueMessage(identityId, {
            target: this.#channelTarget(session, channel),
            senderCharacter: "",
            kind: "sys",
            bbcode: command.payload.message,
            sentByUs: false,
          });
          return;
        }
        case "IGN":
          // Mirror of the server-authoritative ignore list, so snapshots can
          // serve it without (or before) a live session.
          this.#enqueueIgnores(identityId, command.payload);
          return;
        case "JCH":
          if (command.payload.character.identity === session.character) {
            this.#enqueueJoinedFlag(
              identityId,
              {
                kind: "channel",
                key: command.payload.channel,
                title: command.payload.title,
              },
              true,
            );
          }
          return;
        case "LCH":
          if (command.payload.character === session.character) {
            this.#enqueueJoinedFlag(
              identityId,
              this.#channelTarget(session, command.payload.channel),
              false,
            );
          }
          return;
        default:
          return;
      }
    });

    const offSent = session.events.on("sent", (sent: OutboundMessage) => {
      this.#enqueueMessage(identityId, {
        target:
          sent.kind === "pm"
            ? pmTarget(sent.recipient)
            : this.#channelTarget(session, sent.channel),
        senderCharacter: session.character,
        kind:
          sent.kind === "channel" ? "msg" : sent.kind === "ad" ? "lrp" : "pm",
        bbcode: sent.message,
        sentByUs: true,
      });
    });

    const offStatus = session.events.on("status", (event) => {
      if (event.status === "stopped") {
        offCommand();
        offSent();
        offStatus();
      }
    });
  }

  /** Resolves once everything enqueued so far is written (used by tests). */
  async flush(): Promise<void> {
    await Promise.all(this.#queues.values());
  }

  /** Find-or-create a PM conversation (gateway `pm.open`). */
  async ensurePmConversation(
    identityId: string,
    partner: string,
  ): Promise<ConversationRow> {
    const target = pmTarget(partner);
    const existing = await this.#findConversation(identityId, target);
    if (!existing) {
      const [row] = await this.#db
        .select({ total: count() })
        .from(conversations)
        .where(eq(conversations.identityId, identityId));
      if ((row?.total ?? 0) >= this.#maxConversationsPerIdentity) {
        throw new ConversationLimitError();
      }
    }
    const id = await this.#conversationId(identityId, target);
    const [row] = await this.#db
      .select()
      .from(conversations)
      .where(eq(conversations.id, id))
      .limit(1);
    if (!row) {
      throw new Error("conversation vanished after find-or-create");
    }
    return row;
  }

  /**
   * Advances the read cursor (gateway `ack`), monotonically — a stale ack
   * from a lagging tab never moves it backwards — and clamped to the
   * conversation's real newest message, so a bogus huge ack can't pin the
   * cursor above all future messages forever. Emits the updated row so
   * unread counters sync across every attached client.
   */
  async markRead(
    identityId: string,
    conversationId: string,
    messageId: number,
  ): Promise<ConversationRow | undefined> {
    const maxId = sql`(select coalesce(max(${messages.id}), 0) from ${messages} where ${messages.conversationId} = ${conversations.id})`;
    const [row] = await this.#db
      .update(conversations)
      .set({
        lastReadMessageId: sql`greatest(coalesce(${conversations.lastReadMessageId}, 0), least(${messageId}, ${maxId}))`,
      })
      .where(
        and(
          eq(conversations.id, conversationId),
          eq(conversations.identityId, identityId),
        ),
      )
      .returning();
    if (row) {
      this.events.emit("conversation", { identityId, conversation: row });
    }
    return row;
  }

  /**
   * Pins/unpins a conversation (gateway `conv.pin`). Pinned channels are the
   * ones an explicit connect rejoins (decisions.md §9). Emits the updated row
   * so every tab converges.
   */
  async setPinned(
    identityId: string,
    conversationId: string,
    pinned: boolean,
  ): Promise<ConversationRow | undefined> {
    const [row] = await this.#db
      .update(conversations)
      .set({ pinned })
      .where(
        and(
          eq(conversations.id, conversationId),
          eq(conversations.identityId, identityId),
        ),
      )
      .returning();
    if (row) {
      this.events.emit("conversation", { identityId, conversation: row });
    }
    return row;
  }

  /**
   * Channel seed for an explicit return from a log-off (decisions.md §9
   * scenario 3): only pinned channels come back. Read-only — the joined-flag
   * reconcile is a separate, deliberately deferred step
   * (reconcileJoinedForConnect).
   */
  pinnedChannelKeys(identityId: string): Promise<string[]> {
    return this.#channelKeys(identityId, eq(conversations.pinned, true));
  }

  /**
   * Channel seed for recovery (decisions.md §9 scenario 2 — restart, outage:
   * the user never chose to leave): exactly the channels the identity was
   * in, per the joined flags the sink itself maintains.
   */
  channelsForResume(identityId: string): Promise<string[]> {
    return this.#channelKeys(identityId, eq(conversations.joined, true));
  }

  /**
   * Scenario-3 reconcile: rows still flagged joined but not pinned flip to
   * joined = false, so a later restart recovery doesn't resurrect channels
   * the user deliberately left behind. Destructive — callers must run it
   * only once the explicitly connected session actually reaches online
   * (a failed connect must leave the recovery set intact). Enqueued on the
   * identity's write queue so it serializes behind any joined-flag writes
   * still draining from the previous session.
   */
  reconcileJoinedForConnect(identityId: string): void {
    this.#enqueue(identityId, async () => {
      const dropped = await this.#db
        .update(conversations)
        .set({ joined: false })
        .where(
          and(
            eq(conversations.identityId, identityId),
            eq(conversations.kind, "channel"),
            eq(conversations.joined, true),
            eq(conversations.pinned, false),
          ),
        )
        .returning();
      for (const row of dropped) {
        this.events.emit("conversation", { identityId, conversation: row });
      }
    });
  }

  async #channelKeys(
    identityId: string,
    extraFilter: ReturnType<typeof eq>,
  ): Promise<string[]> {
    const rows = await this.#db
      .select({ channelKey: conversations.channelKey })
      .from(conversations)
      .where(
        and(
          eq(conversations.identityId, identityId),
          eq(conversations.kind, "channel"),
          extraFilter,
        ),
      );
    return rows.flatMap((row) =>
      row.channelKey === null ? [] : [row.channelKey],
    );
  }

  #channelTarget(session: FchatSession, key: string): ConversationTarget {
    return {
      kind: "channel",
      key,
      title: session.state.channels.get(key)?.title ?? key,
    };
  }

  #enqueueMessage(
    identityId: string,
    entry: {
      target: ConversationTarget;
      senderCharacter: string;
      kind: "lrp" | "msg" | "pm" | "rll" | "sys";
      bbcode: string;
      sentByUs: boolean;
      /** Set for inbound channel messages: enables highlight matching. */
      ownCharacter?: string;
    },
  ): void {
    this.#enqueue(identityId, async () => {
      const conversationId = await this.#conversationId(
        identityId,
        entry.target,
      );
      // Matched inside the serial task, before the insert: the flag is part
      // of the row (immutable, decisions.md §10), never a later update.
      const mention =
        entry.ownCharacter !== undefined &&
        !entry.sentByUs &&
        this.#highlights !== undefined &&
        (await this.#highlights.mention(
          identityId,
          entry.ownCharacter,
          entry.bbcode,
        ));
      const [row] = await this.#db
        .insert(messages)
        .values({
          conversationId,
          senderCharacter: entry.senderCharacter,
          kind: entry.kind,
          bbcode: entry.bbcode,
          sentByUs: entry.sentByUs,
          mention,
        })
        .returning();
      if (row) {
        this.events.emit("message", { identityId, message: row });
      }
    });
  }

  #enqueueJoinedFlag(
    identityId: string,
    target: ConversationTarget,
    joined: boolean,
  ): void {
    this.#enqueue(identityId, async () => {
      const conversationId = await this.#conversationId(identityId, target);
      const [row] = await this.#db
        .update(conversations)
        .set({ joined, ...(joined ? { title: target.title } : {}) })
        .where(eq(conversations.id, conversationId))
        .returning();
      if (row) {
        this.events.emit("conversation", { identityId, conversation: row });
      }
    });
  }

  /** The identity's persisted ignore list (snapshot self.ignores). */
  async listIgnores(identityId: string): Promise<string[]> {
    const rows = await this.#db
      .select({ character: ignores.character })
      .from(ignores)
      .where(eq(ignores.identityId, identityId))
      .orderBy(asc(ignores.character));
    return rows.map((row) => row.character);
  }

  #enqueueIgnores(
    identityId: string,
    payload: ServerCommandPayload<"IGN">,
  ): void {
    const { action, character, characters } = payload;
    if (action === "init") {
      this.#enqueue(identityId, async () => {
        // Full replacement: the login list is the truth (names may have
        // been ignored/unignored from another client while we were away).
        // One transaction: a concurrent snapshot read must never see the
        // wiped midpoint, and a failed insert must not leave the mirror
        // empty until the next reconnect.
        await this.#db.transaction(async (tx) => {
          await tx.delete(ignores).where(eq(ignores.identityId, identityId));
          if (characters !== undefined && characters.length > 0) {
            await tx
              .insert(ignores)
              .values(
                characters.map((name) => ({ identityId, character: name })),
              )
              .onConflictDoNothing();
          }
        });
      });
    } else if (action === "add" && character !== undefined) {
      this.#enqueue(identityId, async () => {
        // Replace any differently-cased leftover (the PK is case-sensitive,
        // F-Chat names are not) so the list never shows duplicates.
        await this.#db.transaction(async (tx) => {
          await tx
            .delete(ignores)
            .where(
              and(
                eq(ignores.identityId, identityId),
                sql`lower(${ignores.character}) = lower(${character})`,
              ),
            );
          await tx.insert(ignores).values({ identityId, character });
        });
      });
    } else if (action === "delete" && character !== undefined) {
      this.#enqueue(identityId, async () => {
        // Case-insensitive: the ack echoes canonical casing, but rows from
        // older inits may differ.
        await this.#db
          .delete(ignores)
          .where(
            and(
              eq(ignores.identityId, identityId),
              sql`lower(${ignores.character}) = lower(${character})`,
            ),
          );
      });
    }
  }

  #enqueue(identityId: string, task: () => Promise<void>): void {
    const prior = this.#queues.get(identityId) ?? Promise.resolve();
    const next = prior.then(task).catch((error: unknown) => {
      // History must never take the F-Chat session down with it.
      this.#log.error({ err: error }, "history sink write failed");
    });
    this.#queues.set(identityId, next);
    void next.then(() => {
      // Drop drained chains so the map doesn't grow with every identity ever seen.
      if (this.#queues.get(identityId) === next) {
        this.#queues.delete(identityId);
      }
    });
  }

  /** Find-or-create through the (identity, kind, coalesce(...)) unique index. */
  async #conversationId(
    identityId: string,
    target: ConversationTarget,
  ): Promise<string> {
    const cacheKey = `${identityId}:${target.kind}:${target.cacheKey ?? target.key}`;
    const cached = this.#conversationIds.get(cacheKey);
    if (cached !== undefined) {
      return cached;
    }
    const existing = await this.#findConversation(identityId, target);
    if (existing) {
      this.#conversationIds.set(cacheKey, existing);
      return existing;
    }
    try {
      const [created] = await this.#db
        .insert(conversations)
        .values({
          identityId,
          kind: target.kind,
          channelKey: target.kind === "channel" ? target.key : null,
          partnerCharacter: target.kind === "pm" ? target.key : null,
          title: target.title,
        })
        .returning();
      if (!created) {
        throw new Error("conversation insert returned no row");
      }
      this.#conversationIds.set(cacheKey, created.id);
      this.events.emit("conversation", { identityId, conversation: created });
      return created.id;
    } catch (error) {
      // Lost a create race (e.g. another process in a future sharded world).
      if (!isUniqueViolation(error)) {
        throw error;
      }
      const winner = await this.#findConversation(identityId, target);
      if (!winner) {
        throw error;
      }
      this.#conversationIds.set(cacheKey, winner);
      return winner;
    }
  }

  async #findConversation(
    identityId: string,
    target: ConversationTarget,
  ): Promise<string | undefined> {
    const [row] = await this.#db
      .select({ id: conversations.id })
      .from(conversations)
      .where(
        and(
          eq(conversations.identityId, identityId),
          eq(conversations.kind, target.kind),
          target.kind === "channel"
            ? eq(conversations.channelKey, target.key)
            : // PM partners match case-insensitively: F-Chat resolves PRI
              // recipients regardless of casing, so "nyx" and "Nyx" are one
              // thread (enforced by conversations_identity_partner_uniq).
              sql`lower(${conversations.partnerCharacter}) = lower(${target.key})`,
        ),
      )
      .limit(1);
    return row?.id;
  }
}

function pmTarget(partner: string): ConversationTarget {
  // Lowercased cache key so different casings hit the same entry; the row
  // itself keeps the casing of whoever created the conversation.
  return {
    kind: "pm",
    key: partner,
    cacheKey: partner.toLowerCase(),
    title: partner,
  };
}
