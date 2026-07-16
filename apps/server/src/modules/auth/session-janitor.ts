// Expired auth_sessions rows only stop *working* on their own — nothing
// deleted them (M3 audit / M7 exposure hardening). This sweep is the
// deletion. Same shape as the retention job: interval timer, unref'd,
// error-isolated.

import { lt } from "drizzle-orm";
import type { Db } from "../../db/index.js";
import { authSessions } from "../../db/schema.js";

export const SESSION_SWEEP_INTERVAL_MS = 60 * 60 * 1000;

interface JanitorLogger {
  info: (obj: object, msg: string) => void;
  error: (obj: object, msg: string) => void;
}

export interface SessionJanitorOptions {
  db: Db;
  logger: JanitorLogger;
  sweepIntervalMs?: number;
}

export class SessionJanitor {
  readonly #db: Db;
  readonly #logger: JanitorLogger;
  readonly #intervalMs: number;
  #timer: NodeJS.Timeout | undefined;

  constructor(options: SessionJanitorOptions) {
    this.#db = options.db;
    this.#logger = options.logger;
    this.#intervalMs = options.sweepIntervalMs ?? SESSION_SWEEP_INTERVAL_MS;
  }

  start(): void {
    if (this.#timer) {
      return;
    }
    this.#timer = setInterval(() => {
      void this.sweep();
    }, this.#intervalMs);
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }
  }

  /** Exposed for tests; the timer just calls this. */
  async sweep(): Promise<number> {
    try {
      const deleted = await this.#db
        .delete(authSessions)
        .where(lt(authSessions.expiresAt, new Date()))
        .returning({ id: authSessions.id });
      if (deleted.length > 0) {
        this.#logger.info(
          { deleted: deleted.length },
          "expired auth sessions swept",
        );
      }
      return deleted.length;
    } catch (error) {
      this.#logger.error({ err: error }, "auth session sweep failed");
      return 0;
    }
  }
}
