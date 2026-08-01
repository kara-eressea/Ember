// The browser side of /gateway (architecture.md §WebSocket /gateway): one
// module-singleton socket per tab. Owns the hello handshake (access token +
// per-conversation resume cursors), cmd acks by request id, read-cursor
// acks, keepalive pings, and reconnect with backoff. Frames land in
// gateway/dispatch.ts; connection state lands in the ui store.

import {
  GATEWAY_CLOSE,
  PROTOCOL_VERSION,
  type ClientFrame,
  type ConversationDto,
  type GatewayCmd,
  type MessageDto,
  type ResumeCursors,
  type ServerFrame,
} from "@emberchat/protocol";
import { useAuthStore } from "../stores/auth.js";
import { resumeCursorsFor } from "../stores/messages.js";
import { useSessionsStore } from "../stores/sessions.js";
import { useUiStore } from "../stores/ui.js";
import { dispatchFrame } from "./dispatch.js";

const ACK_TIMEOUT_MS = 15_000;
/** Well under MAX_FRAMES_PER_MINUTE; detects dead sockets behind NATs. */
const PING_INTERVAL_MS = 30_000;
/**
 * A socket whose ping went unanswered for this long is dead in a way the
 * browser never reports (sleep/resume, a NAT or proxy dropping an idle
 * tunnel): it stays readyState OPEN while nothing arrives, so the tab shows
 * "online" and quietly stops updating. Close it and reconnect — the hello's
 * resume cursors replay whatever was missed (#407).
 */
const PONG_TIMEOUT_MS = 10_000;
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
/**
 * Lifecycle events that mean "this tab may have just come back": the browser
 * throttles — and around sleep/resume Firefox outright suspends — timers in a
 * hidden or frozen tab, so the keepalive above can be hours late while the
 * socket is already dead and the log silently stops updating (#432). These
 * fire on the way back regardless of what the timers did.
 */
const WAKE_WINDOW_EVENTS = ["focus", "online", "pageshow"] as const;
/** `resume` is Page Lifecycle: a frozen tab thawing. */
const WAKE_DOCUMENT_EVENTS = ["resume", "visibilitychange"] as const;
/** A resume fires several wake events at once; collapse them into one probe. */
const PROBE_DEBOUNCE_MS = 250;
/**
 * A socket that has heard nothing for this long when the tab wakes is
 * suspect — readyState says OPEN either way, so ask it. Well under the
 * keepalive interval, so any recently-pinged socket answers for free.
 */
const PROBE_SILENCE_MS = 5_000;
/** Pong deadline for a wake probe. Tighter than the keepalive's: the user is
 * looking at the tab right now, and reconnecting to our own bouncer is cheap
 * (the ≥10s F-List backoff binds the server's upstream socket, not this one). */
const PROBE_PONG_TIMEOUT_MS = 3_000;

export interface AckResult {
  ok: boolean;
  error?: string;
  conversation?: ConversationDto;
  /** outbox.recall: the typed source, back to the composer. */
  markdown?: string;
  /** history.page: one older page, ascending by id. */
  messages?: MessageDto[];
  /** history.page: older history still exists past this page. */
  hasMore?: boolean;
}

interface PendingAck {
  resolve: (result: AckResult) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class GatewayClient {
  #ws: WebSocket | undefined;
  #nextId = 1;
  readonly #pending = new Map<number, PendingAck>();
  readonly #subs = new Set<string>();
  /** Highest read-acked messages.id per conversation (skip stale acks). */
  readonly #acked = new Map<string, number>();
  #wanted = false;
  #backoffMs = RECONNECT_MIN_MS;
  /** One token refresh per consecutive 4401 — a second one means the account
   * really is signed out and the auth store redirect takes over. */
  #authRetried = false;
  #pingTimer: ReturnType<typeof setInterval> | undefined;
  #pongTimer: ReturnType<typeof setTimeout> | undefined;
  #reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  #probeTimer: ReturnType<typeof setTimeout> | undefined;
  /** Registered while connected, so the singleton owns its own listeners. */
  #onWake: ((event: Event) => void) | undefined;
  /** Timestamp of the last inbound frame — the wake probe's staleness test. */
  #lastFrameAt = 0;
  /** Timestamp of the last #open(), so a burst of wake events can never
   * out-run the reconnect backoff it bypasses. */
  #lastOpenAt = 0;

  /** Idempotent: safe to call from every AppShell mount. */
  connect(): void {
    this.#wanted = true;
    this.#listenForWake();
    if (this.#ws || this.#reconnectTimer) {
      return;
    }
    this.#open();
  }

  /** Deliberate teardown (sign-out); no reconnect. */
  stop(): void {
    this.#wanted = false;
    this.#stopListeningForWake();
    if (this.#reconnectTimer) {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = undefined;
    }
    this.#ws?.close(1000, "client stopped");
    this.#ws = undefined;
  }

  sub(identityId: string): void {
    if (this.#subs.has(identityId)) {
      return;
    }
    this.#subs.add(identityId);
    this.#sendFrame({ t: "sub", d: { identityId } });
  }

  unsub(identityId: string): void {
    if (this.#subs.delete(identityId)) {
      this.#sendFrame({ t: "unsub", d: { identityId } });
    }
  }

  /** Sends a command; resolves with the server's ack. */
  cmd(command: GatewayCmd): Promise<AckResult> {
    if (this.#ws?.readyState !== WebSocket.OPEN) {
      return Promise.resolve({ ok: false, error: "not connected" });
    }
    const id = this.#nextId++;
    return new Promise<AckResult>((resolve) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        resolve({ ok: false, error: "timed out" });
      }, ACK_TIMEOUT_MS);
      this.#pending.set(id, { resolve, timer });
      this.#sendFrame({ t: "cmd", id, d: command });
    });
  }

  /** Advances the server read cursor; monotonic per conversation. */
  readAck(identityId: string, convId: string, messageId: number): void {
    if ((this.#acked.get(convId) ?? 0) >= messageId) {
      return;
    }
    this.#acked.set(convId, messageId);
    this.#sendFrame({ t: "ack", d: { identityId, convId, messageId } });
  }

  /**
   * Marks a conversation read up to its newest message without having that id
   * loaded (#315: "Mark as read" from a sidebar row, where the message buffer
   * may be empty). The server's markRead clamps the id to the true max, so a
   * sentinel means "everything up to now"; the resulting conversation.updated
   * fans out and sticks across devices/reattach exactly like viewing does.
   * Deliberately bypasses #acked — that map guards the live per-message
   * readAck, and a sentinel recorded there would suppress genuine acks for
   * messages that arrive later.
   */
  markReadToLatest(identityId: string, convId: string): void {
    this.#sendFrame({
      t: "ack",
      d: { identityId, convId, messageId: Number.MAX_SAFE_INTEGER },
    });
  }

  #open(): void {
    useUiStore.getState().setGatewayStatus("connecting");
    this.#lastOpenAt = Date.now();
    this.#lastFrameAt = Date.now();
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${proto}//${location.host}/gateway`);
    this.#ws = ws;

    ws.onopen = () => {
      const token = useAuthStore.getState().accessToken;
      if (token === undefined) {
        ws.close(1000, "no session");
        return;
      }
      this.#sendFrame({
        t: "hello",
        d: { token, protocolVersion: PROTOCOL_VERSION, resume: this.#resume() },
      });
      // The server processes frames in order, so subs may follow the hello
      // immediately; each one answers with snapshot + catchup.
      for (const identityId of this.#subs) {
        this.#sendFrame({ t: "sub", d: { identityId } });
      }
      this.#pingTimer = setInterval(() => {
        this.#sendFrame({ t: "ping" });
        // Never push out a deadline already running — a wake probe's is
        // tighter on purpose.
        if (this.#pongTimer === undefined) {
          this.#awaitPong(ws, PONG_TIMEOUT_MS);
        }
      }, PING_INTERVAL_MS);
    };

    ws.onmessage = (event: MessageEvent<string>) => {
      this.#lastFrameAt = Date.now();
      let frame: ServerFrame;
      try {
        frame = JSON.parse(event.data) as ServerFrame;
      } catch {
        return; // the server never sends non-JSON; ignore defensively
      }
      if (frame.t === "ready") {
        this.#backoffMs = RECONNECT_MIN_MS;
        this.#authRetried = false;
        useUiStore.getState().setGatewayStatus("online");
      }
      // Any frame proves the socket is alive, not just the pong itself.
      if (this.#pongTimer) {
        clearTimeout(this.#pongTimer);
        this.#pongTimer = undefined;
      }
      if (frame.t === "ack") {
        const pending = this.#pending.get(frame.id);
        if (pending) {
          this.#pending.delete(frame.id);
          clearTimeout(pending.timer);
          pending.resolve(frame.d);
        }
        return;
      }
      dispatchFrame(frame);
    };

    ws.onclose = (event: CloseEvent) => {
      if (this.#ws !== ws) {
        return; // superseded
      }
      this.#teardownSocket();
      if (!this.#wanted) {
        useUiStore.getState().setGatewayStatus("offline");
        return;
      }
      if (event.code === GATEWAY_CLOSE.unauthorized) {
        void this.#handleUnauthorized();
        return;
      }
      this.#scheduleReconnect();
    };

    ws.onerror = () => {
      // onclose always follows; nothing to do here.
    };
  }

  /** Access token expired or session revoked: refresh once, then retry. */
  async #handleUnauthorized(): Promise<void> {
    if (this.#authRetried) {
      // Refresh already succeeded once and the gateway still refused —
      // treat as signed out rather than hammering the server.
      this.#wanted = false;
      useUiStore.getState().setGatewayStatus("offline");
      return;
    }
    this.#authRetried = true;
    const alive = await useAuthStore.getState().refreshSession();
    if (!alive || !this.#wanted) {
      // Really signed out; the auth store redirect handles the rest.
      this.#wanted = false;
      useUiStore.getState().setGatewayStatus("offline");
      return;
    }
    this.#open();
  }

  // ── wake probing ───────────────────────────────────────────────────────────

  #listenForWake(): void {
    if (this.#onWake !== undefined || typeof window === "undefined") {
      return;
    }
    const onWake = (event: Event) => {
      // visibilitychange fires in both directions; going hidden is not a wake.
      if (event.type === "visibilitychange" && document.hidden) {
        return;
      }
      this.#scheduleProbe();
    };
    this.#onWake = onWake;
    for (const type of WAKE_WINDOW_EVENTS) {
      window.addEventListener(type, onWake);
    }
    for (const type of WAKE_DOCUMENT_EVENTS) {
      document.addEventListener(type, onWake);
    }
  }

  #stopListeningForWake(): void {
    const onWake = this.#onWake;
    if (onWake === undefined) {
      return;
    }
    this.#onWake = undefined;
    for (const type of WAKE_WINDOW_EVENTS) {
      window.removeEventListener(type, onWake);
    }
    for (const type of WAKE_DOCUMENT_EVENTS) {
      document.removeEventListener(type, onWake);
    }
    if (this.#probeTimer) {
      clearTimeout(this.#probeTimer);
      this.#probeTimer = undefined;
    }
  }

  #scheduleProbe(): void {
    this.#probeTimer ??= setTimeout(() => {
      this.#probeTimer = undefined;
      this.#probe();
    }, PROBE_DEBOUNCE_MS);
  }

  /**
   * The tab is back. Nothing here trusts a timer: whatever the browser did to
   * them while we were away, this runs off the lifecycle event itself.
   */
  #probe(): void {
    if (!this.#wanted) {
      return;
    }
    const ws = this.#ws;
    if (ws === undefined) {
      // Parked in the reconnect backoff (up to 30s) with the user waiting.
      // The rate floor keeps a flurry of wake events to one attempt.
      if (Date.now() - this.#lastOpenAt < RECONNECT_MIN_MS) {
        return;
      }
      if (this.#reconnectTimer) {
        clearTimeout(this.#reconnectTimer);
        this.#reconnectTimer = undefined;
      }
      this.#open();
      return;
    }
    if (ws.readyState !== WebSocket.OPEN) {
      return; // still opening (or already closing) — onopen/onclose decides
    }
    if (Date.now() - this.#lastFrameAt < PROBE_SILENCE_MS) {
      return; // demonstrably alive
    }
    this.#sendFrame({ t: "ping" });
    this.#awaitPong(ws, PROBE_PONG_TIMEOUT_MS);
  }

  /** Close `ws` unless some frame arrives within `timeoutMs` (onmessage
   * clears the deadline — a pong is only the cheapest such frame). */
  #awaitPong(ws: WebSocket, timeoutMs: number): void {
    if (this.#pongTimer) {
      clearTimeout(this.#pongTimer);
    }
    this.#pongTimer = setTimeout(() => {
      this.#pongTimer = undefined;
      if (this.#ws === ws) {
        ws.close(1000, "no pong");
      }
    }, timeoutMs);
  }

  #scheduleReconnect(): void {
    useUiStore.getState().setGatewayStatus("connecting");
    const delay = this.#backoffMs;
    this.#backoffMs = Math.min(this.#backoffMs * 2, RECONNECT_MAX_MS);
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = undefined;
      if (this.#wanted) {
        this.#open();
      }
    }, delay);
  }

  #teardownSocket(): void {
    this.#ws = undefined;
    if (this.#pingTimer) {
      clearInterval(this.#pingTimer);
      this.#pingTimer = undefined;
    }
    if (this.#pongTimer) {
      clearTimeout(this.#pongTimer);
      this.#pongTimer = undefined;
    }
    for (const [, pending] of this.#pending) {
      clearTimeout(pending.timer);
      pending.resolve({ ok: false, error: "connection lost" });
    }
    this.#pending.clear();
  }

  /** Resume cursors for every conversation we hold messages for, so the
   * reconnect's catchup replays only what this tab missed. */
  #resume(): ResumeCursors {
    const { sessions } = useSessionsStore.getState();
    const resume: ResumeCursors = {};
    for (const identityId of this.#subs) {
      const session = sessions[identityId];
      if (!session) {
        continue;
      }
      const convIds = [
        ...Object.keys(session.channelByConvId),
        ...Object.keys(session.dms),
      ];
      const convCursors = resumeCursorsFor(convIds);
      if (Object.keys(convCursors).length > 0) {
        resume[identityId] = { convCursors };
      }
    }
    return resume;
  }

  #sendFrame(frame: ClientFrame): void {
    if (this.#ws?.readyState === WebSocket.OPEN) {
      this.#ws.send(JSON.stringify(frame));
    }
  }
}

export const gateway = new GatewayClient();
