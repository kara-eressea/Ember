// History sink — subscribes to a session's event bus and persists MSG/PRI/SYS
// (inbound and our own sends) into conversations/messages. The messages table
// is the gateway resume log (architecture.md §Resume semantics): bigserial
// ids in arrival order are the cursor, so writes go through a serial queue.

import { and, eq } from "drizzle-orm";
import type { Db } from "../../db/index.js";
import { isUniqueViolation } from "../../db/errors.js";
import { conversations, messages } from "../../db/schema.js";
import type { OutboundMessage } from "../session-engine/event-bus.js";
import type {
  FchatSession,
  SessionLogger,
} from "../session-engine/fchat-session.js";

type ConversationKind = "channel" | "pm";

interface ConversationTarget {
  readonly kind: ConversationKind;
  /** Channel key or PM partner — the coalesce() side of the unique index. */
  readonly key: string;
  readonly title: string;
}

const NOOP_LOGGER: SessionLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

export class HistorySink {
  readonly #db: Db;
  readonly #log: SessionLogger;
  /** Serial write queue: message ids must reflect arrival order. */
  #queue: Promise<void> = Promise.resolve();
  /** conversation-row cache, keyed `${identityId}:${kind}:${key}`. */
  readonly #conversationIds = new Map<string, string>();

  constructor(db: Db, logger?: SessionLogger) {
    this.#db = db;
    this.#log = logger ?? NOOP_LOGGER;
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
            // gateway will surface them transiently (step 8).
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
  flush(): Promise<void> {
    return this.#queue;
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
    this.#enqueue(async () => {
      const conversationId = await this.#conversationId(
        identityId,
        entry.target,
      );
      await this.#db.insert(messages).values({
        conversationId,
        senderCharacter: entry.senderCharacter,
        kind: entry.kind,
        bbcode: entry.bbcode,
        sentByUs: entry.sentByUs,
      });
    });
  }

  #enqueueJoinedFlag(
    identityId: string,
    target: ConversationTarget,
    joined: boolean,
  ): void {
    this.#enqueue(async () => {
      const conversationId = await this.#conversationId(identityId, target);
      await this.#db
        .update(conversations)
        .set({ joined, ...(joined ? { title: target.title } : {}) })
        .where(eq(conversations.id, conversationId));
    });
  }

  #enqueue(task: () => Promise<void>): void {
    this.#queue = this.#queue.then(task).catch((error: unknown) => {
      // History must never take the F-Chat session down with it.
      this.#log.error({ err: error }, "history sink write failed");
    });
  }

  /** Find-or-create through the (identity, kind, coalesce(...)) unique index. */
  async #conversationId(
    identityId: string,
    target: ConversationTarget,
  ): Promise<string> {
    const cacheKey = `${identityId}:${target.kind}:${target.key}`;
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
        .returning({ id: conversations.id });
      if (!created) {
        throw new Error("conversation insert returned no row");
      }
      this.#conversationIds.set(cacheKey, created.id);
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
            : eq(conversations.partnerCharacter, target.key),
        ),
      )
      .limit(1);
    return row?.id;
  }
}

function pmTarget(partner: string): ConversationTarget {
  return { kind: "pm", key: partner, title: partner };
}
