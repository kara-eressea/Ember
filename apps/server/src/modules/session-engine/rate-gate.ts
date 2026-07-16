// Outbound flood control. F-Chat requires msg_flood seconds between MSG
// commands and (documented as "the same as MSG") between PRI commands — the
// server tracks them separately, so each command class gets its own timeline.
// Intervals are read from live server VARs at send time, never hardcoded
// (developer policy).

/** Command classes with a flood limit. MSG and PRI pace on msg_flood; ads
 * pace on lfrp_flood (1 per 10 minutes live) **per channel** — ERR 56's own
 * text says "to a channel", and the official client posts to several
 * channels on independent timers (M6 audit; confirm on the supervised live
 * pass). Each interval comes from live VARs. STA, IGN, TPN and the
 * directory queries (CHA/ORS) have no documented VAR of their own; they
 * ride the msg_flood pace as client-side discipline — the server throttles
 * on its side, and nothing user-triggered may spam the wire unmetered. CHA
 * and ORS are separate classes so one directory refresh puts both frames on
 * the wire together while repeat refreshes still pace. */
export type RateGateClass =
  | "MSG"
  | "PRI"
  | `LRP:${string}`
  | "STA"
  | "IGN"
  | "TPN"
  | "CHA"
  | "ORS"
  /** Room management (CCR/CIU/RST) shares one timeline — rare, user-clicked. */
  | "ROOM";

/**
 * Padding on top of the server's flood window. The server measures the
 * window at its own receive time, so two frames spaced exactly msg_flood
 * apart on our side can arrive compressed by transit/event-loop jitter and
 * still be rejected — pad the client-side spacing to absorb that.
 */
export const FLOOD_MARGIN_MS = 100;

/**
 * Per-class backlog bound. The gate only *delays* — without a cap, a client
 * bursting sends would queue hours of messages that keep going out as the
 * character long after it disconnected, with memory to match.
 */
export const MAX_QUEUE_LENGTH = 32;

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

export class RateGateFullError extends Error {
  constructor(limit: number) {
    super(`Send queue is full (${String(limit)} pending) — slow down`);
    this.name = "RateGateFullError";
  }
}

export interface RateGateOptions {
  readonly maxQueueLength?: number;
}

export class RateGate {
  readonly #intervalSecondsFor: (cls: RateGateClass) => number;
  readonly #classes = new Map<RateGateClass, ClassState>();
  readonly #maxQueueLength: number;

  constructor(
    intervalSecondsFor: (cls: RateGateClass) => number,
    options: RateGateOptions = {},
  ) {
    this.#intervalSecondsFor = intervalSecondsFor;
    this.#maxQueueLength = options.maxQueueLength ?? MAX_QUEUE_LENGTH;
  }

  /**
   * Queues `send` behind the class's flood window; resolves once it ran.
   * FIFO per class; classes never delay each other. Rejects immediately when
   * the class backlog is at capacity.
   */
  schedule(cls: RateGateClass, send: () => void): Promise<void> {
    const state = this.#stateFor(cls);
    if (state.queue.length >= this.#maxQueueLength) {
      return Promise.reject(new RateGateFullError(this.#maxQueueLength));
    }
    return new Promise<void>((resolve, reject) => {
      state.queue.push({ send, resolve, reject });
      this.#pump(cls, state);
    });
  }

  /**
   * Estimated wait (ms) before a send scheduled NOW would reach the wire:
   * the current slot's remaining cooldown plus a full interval per item
   * already queued. Lets callers fail fast instead of parking work behind
   * a long window (the 10-minute ad pace outlives every ack timeout).
   */
  waitMs(cls: RateGateClass): number {
    const state = this.#classes.get(cls);
    if (!state) {
      return 0;
    }
    const intervalMs = this.#intervalSecondsFor(cls) * 1000 + FLOOD_MARGIN_MS;
    const cooldown =
      state.lastSentAt === 0
        ? 0
        : Math.max(0, state.lastSentAt + intervalMs - Date.now());
    return cooldown + state.queue.length * intervalMs;
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
