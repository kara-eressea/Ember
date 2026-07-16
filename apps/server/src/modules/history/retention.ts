// Retention job (M2 scaffold, M7 policies). "forever" keeps everything;
// the age policies delete messages older than their cutoff, in bounded
// batches so a first sweep over years of history can't hold a transaction
// (or the event loop's db pool) hostage.

import { inArray, lt, sql } from "drizzle-orm";
import type { Db } from "../../db/index.js";
import { messages } from "../../db/schema.js";
import type { SessionLogger } from "../session-engine/fchat-session.js";

export type RetentionPolicy = "forever" | "30d" | "90d" | "1y";

const POLICY_MAX_AGE_MS: Record<Exclude<RetentionPolicy, "forever">, number> = {
  "30d": 30 * 86_400_000,
  "90d": 90 * 86_400_000,
  "1y": 365 * 86_400_000,
};

/** Rows deleted per statement; the sweep loops until the backlog is gone. */
export const RETENTION_BATCH_SIZE = 5_000;

export interface RetentionJobOptions {
  readonly db: Db;
  readonly policy: RetentionPolicy;
  readonly sweepIntervalMs: number;
  readonly logger?: SessionLogger;
}

export class RetentionJob {
  readonly #options: RetentionJobOptions;
  #timer: NodeJS.Timeout | undefined;

  constructor(options: RetentionJobOptions) {
    this.#options = options;
  }

  start(): void {
    if (this.#timer) {
      return;
    }
    this.#options.logger?.info(
      { policy: this.#options.policy },
      "retention policy active",
    );
    this.#timer = setInterval(() => {
      void this.sweepOnce();
    }, this.#options.sweepIntervalMs);
    // A background sweep must never keep the process alive on shutdown.
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }
  }

  /** One sweep pass; returns how many messages were deleted. */
  async sweepOnce(): Promise<{ deleted: number }> {
    try {
      return await this.#sweep();
    } catch (error) {
      // Retention must never take the server down; the next tick retries.
      this.#options.logger?.error({ err: error }, "retention sweep failed");
      return { deleted: 0 };
    }
  }

  async #sweep(): Promise<{ deleted: number }> {
    if (this.#options.policy === "forever") {
      return { deleted: 0 };
    }
    const cutoff = new Date(
      Date.now() - POLICY_MAX_AGE_MS[this.#options.policy],
    );
    let deleted = 0;
    for (;;) {
      const batch = await this.#options.db
        .delete(messages)
        .where(
          inArray(
            messages.id,
            this.#options.db
              .select({ id: messages.id })
              .from(messages)
              .where(lt(messages.createdAt, cutoff))
              .limit(RETENTION_BATCH_SIZE),
          ),
        )
        .returning({ id: sql<number>`1` });
      deleted += batch.length;
      if (batch.length < RETENTION_BATCH_SIZE) {
        break;
      }
    }
    if (deleted > 0) {
      this.#options.logger?.info(
        { deleted, policy: this.#options.policy },
        "retention sweep deleted expired messages",
      );
    }
    return { deleted };
  }
}
