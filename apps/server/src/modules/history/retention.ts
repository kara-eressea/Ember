// Retention job scaffold (milestone-2 §Scope). The sweep loop, config keys
// and app lifecycle exist now so M7's real policies (age/size, per-user
// opt-outs) plug into #sweep without re-architecting; the default — and so
// far only — policy is "forever", whose sweep deletes nothing.

import type { Db } from "../../db/index.js";
import type { SessionLogger } from "../session-engine/fchat-session.js";

export type RetentionPolicy = "forever";

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
    switch (this.#options.policy) {
      case "forever":
        // Nothing expires. M7 policies branch here (delete from messages
        // where createdAt < cutoff, batched, per-user overrides).
        return Promise.resolve({ deleted: 0 });
    }
  }
}
