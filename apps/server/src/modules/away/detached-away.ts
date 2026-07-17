// Detached auto-away (M5, decisions.md §10): opt-in per user — when an
// identity's session has had zero gateway subscribers for N minutes, the
// bouncer sets STA away with the user's away message; the next attach
// restores what the status was. Off by default. The sweep only ever moves a
// status *from "online"*: a manually chosen away/busy/looking/dnd is the
// user's, and the bouncer never clobbers it.
//
// The same sweep enforces the detached-disconnect ceiling (M8, decisions.md
// §15): a session nobody has attached to for DETACHED_DISCONNECT_HOURS is
// stopped outright — holding an F-Chat connection no one reads for days is
// discourteous to F-List. autoConnect intent stays true and the vault keeps
// the credentials, so the next attach reconnects automatically with the
// exact channel set (§9 scenario 2).

import { eq } from "drizzle-orm";
import { resolvePrefs } from "@emberchat/protocol";
import type { ClientSettableStatus } from "@emberchat/protocol";
import type { Db } from "../../db/index.js";
import { flistAccounts, identities, userPreferences } from "../../db/schema.js";
import type { GatewayHub } from "../gateway/gateway.js";
import type { SessionLogger } from "../session-engine/fchat-session.js";
import type { SessionRegistry } from "../session-engine/registry.js";

const DEFAULT_SWEEP_INTERVAL_MS = 60_000;

export interface DetachedAwayOptions {
  db: Db;
  sessions: SessionRegistry;
  hub: GatewayHub;
  logger: SessionLogger;
  sweepIntervalMs?: number;
  /** Stop a session after this long with zero subscribers; 0 = never. */
  disconnectAfterMs?: number;
  /** Injectable clock for tests. */
  now?: () => number;
}

interface RememberedStatus {
  status: ClientSettableStatus;
  statusmsg: string;
}

export class DetachedAway {
  readonly #options: Required<
    Pick<DetachedAwayOptions, "db" | "sessions" | "hub" | "logger">
  > &
    DetachedAwayOptions;
  readonly #now: () => number;
  /** First sweep that saw the identity subscriber-less (epoch ms). */
  readonly #detachedSince = new Map<string, number>();
  /** Statuses we replaced, awaiting restore on the next attach. */
  readonly #applied = new Map<string, RememberedStatus>();
  #timer: ReturnType<typeof setInterval> | undefined;
  #sweeping = false;

  constructor(options: DetachedAwayOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
  }

  start(): void {
    this.#timer = setInterval(() => {
      void this.sweep();
    }, this.#options.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS);
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }
  }

  /**
   * The attach hook (hub.onFirstSubscribe): the user is looking again — the
   * detachment clock resets, and a status we set hands back to what it
   * replaced. Restore only overwrites our own work: if the status moved
   * since (another client, a manual STA racing the attach), it stays.
   */
  onAttach(identityId: string): void {
    this.#detachedSince.delete(identityId);
    const remembered = this.#applied.get(identityId);
    if (!remembered) {
      return;
    }
    this.#applied.delete(identityId);
    const session = this.#options.sessions.get(identityId);
    if (!session || session.status !== "online") {
      return;
    }
    if (session.ownStatus.status !== "away") {
      return;
    }
    session
      .setStatus(remembered.status, remembered.statusmsg)
      .catch((error: unknown) => {
        this.#options.logger.warn(
          { err: error, identityId },
          "detached-away restore failed",
        );
      });
  }

  /**
   * One pass over the running sessions. Detachment is observed here rather
   * than event-driven so sessions that were never attached (a reconnect
   * after a server restart, say) still count from their first
   * subscriber-less sweep.
   */
  async sweep(): Promise<void> {
    if (this.#sweeping) {
      return;
    }
    this.#sweeping = true;
    try {
      const now = this.#now();
      const entries = this.#options.sessions.entries();
      // Prune state for sessions that no longer run (explicit disconnect,
      // identity delete): a stale #applied entry would block re-applying
      // away after a reconnect — the fresh session starts plain "online",
      // there is nothing left to restore.
      const live = new Set(entries.map(([identityId]) => identityId));
      for (const identityId of [...this.#applied.keys()]) {
        if (!live.has(identityId)) {
          this.#applied.delete(identityId);
        }
      }
      for (const identityId of [...this.#detachedSince.keys()]) {
        if (!live.has(identityId)) {
          this.#detachedSince.delete(identityId);
        }
      }
      for (const [identityId, session] of entries) {
        if (this.#options.hub.hasSubscribers(identityId)) {
          this.#detachedSince.delete(identityId);
          continue;
        }
        // The stamp tracks detachment, not connectivity: it is set on the
        // first subscriber-less sweep even while the session is between
        // F-Chat connections, so both thresholds count from the detach.
        const since = this.#detachedSince.get(identityId);
        if (since === undefined) {
          this.#detachedSince.set(identityId, now);
          continue;
        }
        // Detached-disconnect ceiling (decisions.md §15): a session in
        // reconnect-backoff counts too — stopping it also ends the retries.
        const disconnectAfterMs = this.#options.disconnectAfterMs ?? 0;
        if (disconnectAfterMs > 0 && now - since >= disconnectAfterMs) {
          this.#detachedSince.delete(identityId);
          this.#applied.delete(identityId);
          const hours = Math.round(disconnectAfterMs / 3_600_000);
          this.#options.sessions.stop(
            identityId,
            `disconnected after ${String(hours)}h with no attached device`,
          );
          this.#options.logger.info(
            { identityId },
            "detached session disconnected",
          );
          continue;
        }
        if (session.status !== "online") {
          // Not connected to F-Chat — no status to set; the clock keeps
          // counting from the detach, not the reconnect.
          continue;
        }
        if (this.#applied.has(identityId)) {
          continue; // already away by our hand
        }
        if (session.ownStatus.status !== "online") {
          continue; // a chosen status is the user's — never clobber it
        }
        try {
          const prefs = await this.#userPrefs(identityId);
          if (
            !prefs?.detachedAwayEnabled ||
            now - since < prefs.detachedAwayMinutes * 60_000
          ) {
            continue;
          }
          // A browser may have attached during the prefs await — onAttach
          // clears #detachedSince, so a vanished stamp (or a live
          // subscriber) means the user is looking again: don't go away.
          if (
            !this.#detachedSince.has(identityId) ||
            this.#options.hub.hasSubscribers(identityId)
          ) {
            continue;
          }
          const previous = session.ownStatus;
          await session.setStatus("away", prefs.autoAwayMessage);
          if (this.#options.hub.hasSubscribers(identityId)) {
            // Attached while the STA was in flight (the send is flood-
            // gated); onAttach found nothing to restore, so hand back
            // here instead of leaving a fresh attach sitting away.
            await session.setStatus(previous.status, previous.statusmsg);
          } else {
            this.#applied.set(identityId, previous);
            this.#options.logger.info(
              { identityId },
              "detached auto-away applied",
            );
          }
        } catch (error) {
          this.#options.logger.warn(
            { err: error, identityId },
            "detached-away sweep failed for identity",
          );
        }
      }
    } finally {
      this.#sweeping = false;
    }
  }

  /** The owning user's resolved prefs; undefined if the identity vanished. */
  async #userPrefs(identityId: string) {
    const [row] = await this.#options.db
      .select({ prefs: userPreferences.prefs })
      .from(identities)
      .innerJoin(flistAccounts, eq(identities.flistAccountId, flistAccounts.id))
      .leftJoin(
        userPreferences,
        eq(userPreferences.userId, flistAccounts.userId),
      )
      .where(eq(identities.id, identityId))
      .limit(1);
    if (!row) {
      return undefined;
    }
    return resolvePrefs(row.prefs ?? undefined);
  }
}
