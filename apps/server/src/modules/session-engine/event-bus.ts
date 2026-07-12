// Per-session typed event emitter. The gateway (fan-out to browsers) and the
// history sink (message persistence) subscribe here; the session never knows
// about either. A listener that throws is logged and skipped — a broken
// consumer must not take the F-Chat connection down with it.

import type { ServerCommand } from "@emberline/fchat-protocol";
import type { SessionStatus } from "./session-state.js";

export interface SessionEvents {
  /** Session lifecycle transition. */
  status: { status: SessionStatus; reason?: string };
  /** Every known inbound server command, after it was folded into state. */
  command: ServerCommand;
}

type Listener<E> = (event: E) => void;

export interface SessionEventLogger {
  error: (obj: object, msg: string) => void;
}

export class SessionEventBus {
  readonly #listeners = new Map<
    keyof SessionEvents,
    Set<Listener<SessionEvents[keyof SessionEvents]>>
  >();
  readonly #logger: SessionEventLogger | undefined;

  constructor(logger?: SessionEventLogger) {
    this.#logger = logger;
  }

  on<K extends keyof SessionEvents>(
    name: K,
    listener: Listener<SessionEvents[K]>,
  ): () => void {
    let set = this.#listeners.get(name);
    if (!set) {
      set = new Set();
      this.#listeners.set(name, set);
    }
    set.add(listener as Listener<SessionEvents[keyof SessionEvents]>);
    return () => {
      this.off(name, listener);
    };
  }

  off<K extends keyof SessionEvents>(
    name: K,
    listener: Listener<SessionEvents[K]>,
  ): void {
    this.#listeners
      .get(name)
      ?.delete(listener as Listener<SessionEvents[keyof SessionEvents]>);
  }

  emit<K extends keyof SessionEvents>(name: K, event: SessionEvents[K]): void {
    const set = this.#listeners.get(name);
    if (!set) {
      return;
    }
    for (const listener of [...set]) {
      try {
        listener(event);
      } catch (error) {
        this.#logger?.error({ err: error, event: name }, "listener threw");
      }
    }
  }

  removeAllListeners(): void {
    this.#listeners.clear();
  }
}
