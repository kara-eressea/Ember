// Typed event emitters. Each FchatSession carries a SessionEventBus: the
// gateway (fan-out to browsers) and the history sink (message persistence)
// subscribe there; the session never knows about either. The history sink
// carries its own TypedEventBus for post-persistence events. A listener that
// throws is logged and skipped — a broken consumer must not take the F-Chat
// connection down with it.

import type { ServerCommand } from "@emberchat/fchat-protocol";
import type { SessionStatus } from "./session-state.js";

/** An outbound message that actually went onto the wire. The server never
 * echoes MSG/PRI back to the sender, so history and fan-out need this. */
export type OutboundMessage =
  | { kind: "channel"; channel: string; message: string }
  | { kind: "ad"; channel: string; message: string }
  | {
      kind: "pm";
      recipient: string;
      message: string;
      /**
       * Opaque per-send id (#491). F-Chat never acknowledges a PRI and its
       * ERRs carry no reference to the frame that caused them, so the session
       * mints this id, remembers the send for a short window, and quotes it
       * back in `sendFailed` when it correlates a refusal. The history sink
       * uses it to find the row the failure belongs to.
       */
      sendId: string;
      /** Set when this send is a retry of an already-persisted, failed row
       * (`messages.id`): the sink updates that row instead of inserting. */
      retryOf?: number;
    };

/** A PRI the server refused (#491) — see FchatSession's correlation window. */
export interface SendFailure {
  /** The `sendId` of the `sent` event this refusal was attributed to. */
  sendId: string;
  recipient: string;
  /** The F-Chat ERR number (6 = not online, 20 = ignored). */
  code: number;
  /** Plain-language cause, shown under the message in the log. */
  reason: string;
}

export interface SessionEvents {
  /** Session lifecycle transition. */
  status: { status: SessionStatus; reason?: string };
  /** Every known inbound server command, after it was folded into state. */
  command: ServerCommand;
  /** Own MSG/PRI, emitted after the frame passed the flood gate and sent. */
  sent: OutboundMessage;
  /** An own PRI the server answered with a refusal ERR (#491). */
  sendFailed: SendFailure;
}

type Listener<E> = (event: E) => void;

export interface EventBusLogger {
  error: (obj: object, msg: string) => void;
}

export class TypedEventBus<Events extends object> {
  readonly #listeners = new Map<
    keyof Events,
    Set<Listener<Events[keyof Events]>>
  >();
  readonly #logger: EventBusLogger | undefined;

  constructor(logger?: EventBusLogger) {
    this.#logger = logger;
  }

  on<K extends keyof Events>(
    name: K,
    listener: Listener<Events[K]>,
  ): () => void {
    let set = this.#listeners.get(name);
    if (!set) {
      set = new Set();
      this.#listeners.set(name, set);
    }
    set.add(listener as Listener<Events[keyof Events]>);
    return () => {
      this.off(name, listener);
    };
  }

  off<K extends keyof Events>(name: K, listener: Listener<Events[K]>): void {
    this.#listeners
      .get(name)
      ?.delete(listener as Listener<Events[keyof Events]>);
  }

  emit<K extends keyof Events>(name: K, event: Events[K]): void {
    const set = this.#listeners.get(name);
    if (!set) {
      return;
    }
    for (const listener of [...set]) {
      try {
        listener(event);
      } catch (error) {
        this.#logger?.error(
          { err: error, event: name },
          "event listener threw",
        );
      }
    }
  }

  removeAllListeners(): void {
    this.#listeners.clear();
  }
}

export class SessionEventBus extends TypedEventBus<SessionEvents> {}
