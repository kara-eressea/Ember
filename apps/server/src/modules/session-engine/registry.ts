// One FchatSession per identity. Session life is independent of any browser
// connection (always-online bouncer): sessions start on explicit
// `session.connect` (or unlock auto-connect) and stop only on explicit
// `session.disconnect`, identity deletion, or server shutdown.

import type { TicketManagerRegistry } from "../flist-api/ticket-manager.js";
import {
  FchatSession,
  type FchatSessionOptions,
  type SessionLogger,
} from "./fchat-session.js";

/** Test-only timing knobs (integration tests can't wait out the 10s policy
 * floor). Never wired to config — production always runs policy defaults. */
export type SessionTuning = Pick<
  FchatSessionOptions,
  "backoffFloorMs" | "backoffCapMs" | "watchdogMs" | "random"
>;

export interface SessionRegistryOptions {
  readonly tickets: TicketManagerRegistry;
  /** F-Chat WebSocket URL (config FCHAT_URL). */
  readonly wsUrl: string;
  readonly clientName: string;
  readonly clientVersion: string;
  readonly logger?: SessionLogger;
  readonly tuning?: SessionTuning;
  /**
   * Invoked for every newly created session BEFORE it starts connecting, so
   * subscribers (history sink, gateway) never miss an event.
   */
  readonly onSessionStarted?: (
    identityId: string,
    session: FchatSession,
  ) => void;
}

export interface StartSessionParams {
  readonly identityId: string;
  readonly character: string;
  readonly accountId: string;
  readonly accountName: string;
  /**
   * Channels seeded into the desired set of a NEWLY created session (joined
   * at identify). Ignored when a running session exists — a live channel set
   * is never reseeded, so concurrent connect/unlock callers can compute
   * seeds optimistically without racing each other.
   */
  readonly seedChannels?: readonly string[];
}

export class SessionRegistry {
  readonly #options: SessionRegistryOptions;
  readonly #sessions = new Map<string, FchatSession>();

  constructor(options: SessionRegistryOptions) {
    this.#options = options;
  }

  /** Returns the running session for the identity, starting one if needed. */
  start(params: StartSessionParams): FchatSession {
    const existing = this.#sessions.get(params.identityId);
    if (existing && existing.status !== "stopped") {
      return existing;
    }
    const session = new FchatSession({
      character: params.character,
      accountName: params.accountName,
      tickets: this.#options.tickets.managerFor(
        params.accountId,
        params.accountName,
      ),
      wsUrl: this.#options.wsUrl,
      clientName: this.#options.clientName,
      clientVersion: this.#options.clientVersion,
      logger: this.#options.logger,
      ...this.#options.tuning,
    });
    for (const channel of params.seedChannels ?? []) {
      session.joinChannel(channel);
    }
    this.#sessions.set(params.identityId, session);
    this.#options.onSessionStarted?.(params.identityId, session);
    session.start();
    return session;
  }

  get(identityId: string): FchatSession | undefined {
    return this.#sessions.get(identityId);
  }

  /** Snapshot of the running sessions (detached-away sweep, M5). */
  entries(): [string, FchatSession][] {
    return [...this.#sessions.entries()];
  }

  stop(identityId: string, reason?: string): void {
    const session = this.#sessions.get(identityId);
    if (session) {
      session.stop(reason);
      this.#sessions.delete(identityId);
    }
  }

  stopAll(reason = "server shutting down"): void {
    for (const identityId of [...this.#sessions.keys()]) {
      this.stop(identityId, reason);
    }
  }
}
