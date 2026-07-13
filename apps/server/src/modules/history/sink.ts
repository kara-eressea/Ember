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

import { and, count, eq, sql } from "drizzle-orm";
import type { Db } from "../../db/index.js";
import { isUniqueViolation } from "../../db/errors.js";
import { conversations, messages } from "../../db/schema.js";
import {
  TypedEventBus,
  type OutboundMessage,
} from "../session-engine/event-bus.js";
import type {
  FchatSession,
  SessionLogger,
} from "../session-engine/fchat-session.js";

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
  /** Per-identity serial write queues: message ids must reflect arrival order within an identity. */
  readonly #queues = new Map<string, Promise<void>>();
  /** conversation-row cache, keyed `${identityId}:${kind}:${key}`. */
  readonly #conversationIds = new Map<string, string>();

  constructor(
    db: Db,
    logger?: SessionLogger,
    options: { maxConversationsPerIdentity?: number } = {},
  ) {
    this.#db = db;
    this.#log = logger ?? NOOP_LOGGER;
    this.#maxConversationsPerIdentity =
      options.maxConversationsPerIdentity ?? MAX_CONVERSATIONS_PER_IDENTITY;
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
          sent.kind === "channel"
            ? this.#channelTarget(session, sent.channel)
            : pmTarget(sent.recipient),
        senderCharacter: session.character,
        kind: sent.kind === "channel" ? "msg" : "pm",
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
      kind: "msg" | "pm" | "sys";
      bbcode: string;
      sentByUs: boolean;
    },
  ): void {
    this.#enqueue(identityId, async () => {
      const conversationId = await this.#conversationId(
        identityId,
        entry.target,
      );
      const [row] = await this.#db
        .insert(messages)
        .values({
          conversationId,
          senderCharacter: entry.senderCharacter,
          kind: entry.kind,
          bbcode: entry.bbcode,
          sentByUs: entry.sentByUs,
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
