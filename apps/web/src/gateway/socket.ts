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
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

export interface AckResult {
  ok: boolean;
  error?: string;
  conversation?: ConversationDto;
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
  #reconnectTimer: ReturnType<typeof setTimeout> | undefined;

  /** Idempotent: safe to call from every AppShell mount. */
  connect(): void {
    this.#wanted = true;
    if (this.#ws || this.#reconnectTimer) {
      return;
    }
    this.#open();
  }

  /** Deliberate teardown (sign-out); no reconnect. */
  stop(): void {
    this.#wanted = false;
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

  #open(): void {
    useUiStore.getState().setGatewayStatus("connecting");
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
      }, PING_INTERVAL_MS);
    };

    ws.onmessage = (event: MessageEvent<string>) => {
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
