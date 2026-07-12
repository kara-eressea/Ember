// Outbound flood control. F-Chat requires msg_flood seconds between MSG
// commands and (documented as "the same as MSG") between PRI commands — the
// server tracks them separately, so each command class gets its own timeline.
// Intervals are read from live server VARs at send time, never hardcoded
// (developer policy).

/** Command classes with a flood limit. LRP (lfrp_flood) arrives in M4+. */
export type RateGateClass = "MSG" | "PRI";

/**
 * Padding on top of the server's flood window. The server measures the
 * window at its own receive time, so two frames spaced exactly msg_flood
 * apart on our side can arrive compressed by transit/event-loop jitter and
 * still be rejected — pad the client-side spacing to absorb that.
 */
export const FLOOD_MARGIN_MS = 100;

interface Pending {
  readonly send: () => void;
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
}

interface ClassState {
  lastSentAt: number;
  readonly queue: Pending[];
  timer: NodeJS.Timeout | undefined;
}

export class RateGateClearedError extends Error {
  constructor() {
    super("Rate gate cleared before the command was sent");
    this.name = "RateGateClearedError";
  }
}

export class RateGate {
  readonly #intervalSecondsFor: (cls: RateGateClass) => number;
  readonly #classes = new Map<RateGateClass, ClassState>();

  constructor(intervalSecondsFor: (cls: RateGateClass) => number) {
    this.#intervalSecondsFor = intervalSecondsFor;
  }

  /**
   * Queues `send` behind the class's flood window; resolves once it ran.
   * FIFO per class; classes never delay each other.
   */
  schedule(cls: RateGateClass, send: () => void): Promise<void> {
    const state = this.#stateFor(cls);
    return new Promise<void>((resolve, reject) => {
      state.queue.push({ send, resolve, reject });
      this.#pump(cls, state);
    });
  }

  /**
   * Drops everything still queued (connection lost); pending sends reject.
   * Timelines reset too — a new connection gets fresh flood accounting
   * server-side.
   */
  clear(): void {
    for (const state of this.#classes.values()) {
      if (state.timer) {
        clearTimeout(state.timer);
        state.timer = undefined;
      }
      state.lastSentAt = 0;
      for (const pending of state.queue.splice(0)) {
        pending.reject(new RateGateClearedError());
      }
    }
  }

  #stateFor(cls: RateGateClass): ClassState {
    let state = this.#classes.get(cls);
    if (!state) {
      state = { lastSentAt: 0, queue: [], timer: undefined };
      this.#classes.set(cls, state);
    }
    return state;
  }

  #pump(cls: RateGateClass, state: ClassState): void {
    if (state.timer) {
      return;
    }
    const head = state.queue[0];
    if (!head) {
      return;
    }
    const now = Date.now();
    const readyAt =
      state.lastSentAt === 0
        ? 0
        : state.lastSentAt +
          this.#intervalSecondsFor(cls) * 1000 +
          FLOOD_MARGIN_MS;
    if (readyAt > now) {
      state.timer = setTimeout(() => {
        state.timer = undefined;
        this.#pump(cls, state);
      }, readyAt - now);
      return;
    }
    state.queue.shift();
    state.lastSentAt = now;
    try {
      head.send();
    } catch (error) {
      // #pump runs from timers too — surface the failure to the scheduling
      // caller, never as an uncaught timer exception.
      head.reject(error instanceof Error ? error : new Error(String(error)));
      this.#pump(cls, state);
      return;
    }
    head.resolve();
    this.#pump(cls, state);
  }
}
