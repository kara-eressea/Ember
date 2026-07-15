// Server-side delayed-send outbox (milestone-4.md): msg.send with a non-zero
// user delay parks the message in outbox_messages; this worker releases due
// rows into the session's rate gate. Living server-side is the point —
// closing the tab neither loses nor prematurely flushes the queue, and rows
// survive a restart (the first poll after boot releases anything that came
// due while the process was down). Every change fans the identity's full
// pending list as `outbox.updated`, so all attached devices stay in sync.

import { and, asc, eq, inArray, lte } from "drizzle-orm";
import type { OutboxItemDto } from "@emberchat/protocol";
import type { Db } from "../../db/index.js";
import { conversations, outboxMessages } from "../../db/schema.js";
import type { SessionLogger } from "../session-engine/fchat-session.js";
import type { SessionRegistry } from "../session-engine/registry.js";

/** The slice of GatewayHub the outbox needs (structural, avoids a cycle). */
export interface OutboxBroadcaster {
  broadcast(
    identityId: string,
    event: { kind: "outbox.updated"; d: { items: OutboxItemDto[] } },
  ): void;
}

export interface OutboxOptions {
  readonly db: Db;
  readonly sessions: SessionRegistry;
  readonly hub: OutboxBroadcaster;
  readonly logger: SessionLogger;
  /** Test knob; production polls once a second. */
  readonly pollIntervalMs?: number;
}

const POLL_INTERVAL_MS = 1000;

type OutboxRow = typeof outboxMessages.$inferSelect;

function itemDto(row: OutboxRow): OutboxItemDto {
  return {
    id: row.id,
    convId: row.conversationId,
    markdown: row.markdown,
    bbcode: row.bbcode,
    releaseAt: row.releaseAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    // "releasing" is a worker-internal claim; to the user it is still a
    // pending send (recall of it just misses — the send is in flight).
    state: row.state === "failed" ? "failed" : "scheduled",
    ...(row.failureReason !== null ? { failureReason: row.failureReason } : {}),
  };
}

export class Outbox {
  readonly #db: Db;
  readonly #sessions: SessionRegistry;
  readonly #hub: OutboxBroadcaster;
  readonly #log: SessionLogger;
  readonly #pollMs: number;
  #timer: NodeJS.Timeout | undefined;
  #releasing = false;

  constructor(options: OutboxOptions) {
    this.#db = options.db;
    this.#sessions = options.sessions;
    this.#hub = options.hub;
    this.#log = options.logger;
    this.#pollMs = options.pollIntervalMs ?? POLL_INTERVAL_MS;
  }

  start(): void {
    if (this.#timer) {
      return;
    }
    // Rows claimed by a worker that died mid-release are ambiguous — the
    // send may or may not have reached the wire. Surface them as failed
    // with the ambiguity spelled out rather than silently re-sending.
    void this.#db
      .update(outboxMessages)
      .set({
        state: "failed",
        failureReason: "interrupted by a restart — it may have been sent",
      })
      .where(eq(outboxMessages.state, "releasing"))
      .catch((error: unknown) => {
        this.#log.error({ err: error }, "outbox releasing-sweep failed");
      });
    this.#timer = setInterval(() => {
      void this.#tick();
    }, this.#pollMs);
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }
  }

  /** Parks a message; the identity's pending list fans out. */
  async schedule(input: {
    identityId: string;
    conversationId: string;
    markdown: string;
    bbcode: string;
    /** "lrp" = a delayed roleplay ad; released via the LRP pace. */
    kind?: "lrp" | "msg";
    releaseAt: Date;
  }): Promise<void> {
    await this.#db.insert(outboxMessages).values(input);
    await this.#fan(input.identityId);
  }

  /**
   * Cancels a pending (or failed) row and returns what the user typed, so
   * the composer can restore it. Undefined when the row is gone — released,
   * already recalled, or never this identity's.
   */
  async recall(
    identityId: string,
    outboxId: string,
  ): Promise<{ markdown: string } | undefined> {
    const [row] = await this.#db
      .delete(outboxMessages)
      .where(
        and(
          eq(outboxMessages.id, outboxId),
          eq(outboxMessages.identityId, identityId),
          inArray(outboxMessages.state, ["scheduled", "failed"]),
        ),
      )
      .returning();
    if (!row) {
      return undefined;
    }
    await this.#fan(identityId);
    return { markdown: row.markdown };
  }

  /** The identity's pending list (snapshot + fan-out payload). */
  async list(identityId: string): Promise<OutboxItemDto[]> {
    const rows = await this.#db
      .select()
      .from(outboxMessages)
      .where(eq(outboxMessages.identityId, identityId))
      .orderBy(asc(outboxMessages.releaseAt), asc(outboxMessages.createdAt));
    return rows.map(itemDto);
  }

  async #fan(identityId: string): Promise<void> {
    this.#hub.broadcast(identityId, {
      kind: "outbox.updated",
      d: { items: await this.list(identityId) },
    });
  }

  async #tick(): Promise<void> {
    if (this.#releasing) {
      return; // a slow flood gate must not stack overlapping ticks
    }
    this.#releasing = true;
    try {
      const due = await this.#db
        .select({ row: outboxMessages, conversation: conversations })
        .from(outboxMessages)
        .innerJoin(
          conversations,
          eq(outboxMessages.conversationId, conversations.id),
        )
        .where(
          and(
            eq(outboxMessages.state, "scheduled"),
            lte(outboxMessages.releaseAt, new Date()),
          ),
        )
        .orderBy(asc(outboxMessages.releaseAt), asc(outboxMessages.createdAt));
      // Sequential per identity (release order is promised per conversation
      // and each send awaits that session's rate gate), but identities in
      // parallel: one user's congested flood gate must not delay anyone
      // else's releases (audit).
      const byIdentity = new Map<string, typeof due>();
      for (const item of due) {
        const queue = byIdentity.get(item.row.identityId);
        if (queue) {
          queue.push(item);
        } else {
          byIdentity.set(item.row.identityId, [item]);
        }
      }
      await Promise.all(
        [...byIdentity.values()].map(async (queue) => {
          for (const item of queue) {
            await this.#release(item.row, item.conversation);
          }
        }),
      );
    } catch (error) {
      this.#log.error({ err: error }, "outbox poll failed");
    } finally {
      this.#releasing = false;
    }
  }

  async #release(
    row: OutboxRow,
    conversation: typeof conversations.$inferSelect,
  ): Promise<void> {
    // Claim first: once a row is "releasing" it can no longer be recalled,
    // so a recall racing an in-flight send can never hand text back to the
    // composer while the message still goes out (audit — double-post). A
    // claim miss means a recall got there first: nothing to do.
    const [claimed] = await this.#db
      .update(outboxMessages)
      .set({ state: "releasing" })
      .where(
        and(
          eq(outboxMessages.id, row.id),
          eq(outboxMessages.state, "scheduled"),
        ),
      )
      .returning();
    if (!claimed) {
      return;
    }
    try {
      const session = this.#sessions.get(row.identityId);
      if (!session) {
        throw new Error("no live session at release time");
      }
      if (row.kind === "lrp") {
        await session.sendChannelAd(conversation.channelKey ?? "", row.bbcode);
      } else if (conversation.kind === "channel") {
        await session.sendChannelMessage(
          conversation.channelKey ?? "",
          row.bbcode,
        );
      } else {
        await session.sendPrivateMessage(
          conversation.partnerCharacter ?? "",
          row.bbcode,
        );
      }
    } catch (error) {
      // Kept as "failed" with the reason, visible to the user (recall
      // clears it) — a message must never vanish silently or namelessly.
      this.#log.warn({ err: error, outboxId: row.id }, "outbox release failed");
      await this.#db
        .update(outboxMessages)
        .set({
          state: "failed",
          failureReason: error instanceof Error ? error.message : "send failed",
        })
        .where(eq(outboxMessages.id, row.id));
      await this.#fan(row.identityId);
      return;
    }
    // The send is on the wire; the delete is deliberately outside the
    // catch — a transient DB error here must NOT mark a sent message as
    // failed (recalling it would double-post; audit). A row stuck in
    // "releasing" is swept to failed-with-ambiguity at the next start().
    try {
      await this.#db
        .delete(outboxMessages)
        .where(eq(outboxMessages.id, row.id));
    } catch (error) {
      this.#log.error(
        { err: error, outboxId: row.id },
        "outbox delete after send failed — row left in releasing",
      );
    }
    await this.#fan(row.identityId);
  }
}
