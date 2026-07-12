// FchatSession — one state machine per character identity
// (design/architecture.md §FchatSession state machine).
//
// States: idle → acquiring_ticket → connecting → identifying → online
//         → backoff → (acquiring_ticket…) | stopped
//
// Developer-policy constraints enforced here:
// - IDN is the first frame on every connection.
// - At most one outbound PIN per 10 seconds.
// - Reconnect backoff floored at 10 seconds (jittered, capped at 5 minutes).
// - Outbound MSG/PRI go through the rate gate and chat_max/priv_max checks.
// - Unknown inbound commands are logged and swallowed, never fatal.

import { Buffer } from "node:buffer";
import WebSocket from "ws";
import {
  FchatErrorCode,
  isKnownServerCommand,
  parseServerCommand,
  serializeClientCommand,
  type ClientCommand,
} from "@emberline/fchat-protocol";
import {
  AccountLockedError,
  FlistAuthError,
  type TicketManager,
} from "../flist-api/ticket-manager.js";
import { SessionEventBus } from "./event-bus.js";
import { RateGate } from "./rate-gate.js";
import { SessionState, type SessionStatus } from "./session-state.js";

/** Reconnect floor mandated by the F-List developer policy: never below 10s. */
export const RECONNECT_FLOOR_MS = 10_000;
export const RECONNECT_CAP_MS = 5 * 60 * 1000;
/** Never send more than one PIN per 10 seconds (developer policy). */
export const PIN_MIN_INTERVAL_MS = 10_000;
/** Inbound silence after which the connection is considered dead (~3 PINs). */
export const WATCHDOG_MS = 90_000;

export interface BackoffOptions {
  readonly floorMs: number;
  readonly capMs: number;
  readonly random: () => number;
}

/**
 * Jittered exponential backoff: full jitter between the floor and the
 * exponential ceiling for this attempt. Attempt 0 is exactly the floor;
 * the result never leaves [floorMs, capMs].
 */
export function backoffDelayMs(
  attempt: number,
  { floorMs, capMs, random }: BackoffOptions,
): number {
  const ceiling = Math.min(capMs, floorMs * 2 ** attempt);
  return floorMs + random() * (ceiling - floorMs);
}

export interface SessionLogger {
  debug: (obj: object, msg: string) => void;
  info: (obj: object, msg: string) => void;
  warn: (obj: object, msg: string) => void;
  error: (obj: object, msg: string) => void;
}

function rawDataToString(data: WebSocket.RawData): string {
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString("utf8");
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString("utf8");
  }
  return data.toString("utf8");
}

const NOOP_LOGGER: SessionLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

/** The slice of TicketManager the session needs (stubbed in tests). */
export type SessionTickets = Pick<TicketManager, "getTicket" | "invalidate">;

export interface FchatSessionOptions {
  readonly character: string;
  readonly accountName: string;
  readonly tickets: SessionTickets;
  /** F-Chat WebSocket URL (config FCHAT_URL, or fchat-sim's wsUrl). */
  readonly wsUrl: string;
  /** IDN cname/cversion (config CLIENT_NAME/CLIENT_VERSION). */
  readonly clientName: string;
  readonly clientVersion: string;
  readonly logger?: SessionLogger;
  /** Test knobs — production uses the policy defaults above. */
  readonly backoffFloorMs?: number;
  readonly backoffCapMs?: number;
  readonly watchdogMs?: number;
  readonly random?: () => number;
}

export class SessionNotOnlineError extends Error {
  constructor(status: SessionStatus) {
    super(`Session is ${status}, not online`);
    this.name = "SessionNotOnlineError";
  }
}

export class MessageTooLongError extends Error {
  constructor(limit: number) {
    super(`Message exceeds the server's ${String(limit)}-byte limit`);
    this.name = "MessageTooLongError";
  }
}

export class FchatSession {
  readonly character: string;
  readonly accountName: string;
  readonly state = new SessionState();
  readonly events: SessionEventBus;

  readonly #tickets: SessionTickets;
  readonly #wsUrl: string;
  readonly #clientName: string;
  readonly #clientVersion: string;
  readonly #log: SessionLogger;
  readonly #backoff: BackoffOptions;
  readonly #watchdogMs: number;
  readonly #rateGate: RateGate;

  #status: SessionStatus = "idle";
  #socket: WebSocket | undefined;
  #attempt = 0;
  #reconnectTimer: NodeJS.Timeout | undefined;
  #watchdogTimer: NodeJS.Timeout | undefined;
  #lastPinSentAt = 0;
  /** Channels the user wants to be in; rejoined after every reconnect. */
  readonly #desiredChannels = new Set<string>();

  constructor(options: FchatSessionOptions) {
    this.character = options.character;
    this.accountName = options.accountName;
    this.#tickets = options.tickets;
    this.#wsUrl = options.wsUrl;
    this.#clientName = options.clientName;
    this.#clientVersion = options.clientVersion;
    this.#log = options.logger ?? NOOP_LOGGER;
    this.#backoff = {
      floorMs: options.backoffFloorMs ?? RECONNECT_FLOOR_MS,
      capMs: options.backoffCapMs ?? RECONNECT_CAP_MS,
      random: options.random ?? Math.random,
    };
    this.#watchdogMs = options.watchdogMs ?? WATCHDOG_MS;
    this.events = new SessionEventBus(this.#log);
    // MSG and PRI share the documented msg_flood value but the server tracks
    // them separately; LRP (lfrp_flood) joins in M4+.
    this.#rateGate = new RateGate(() => this.state.vars.msg_flood);
  }

  get status(): SessionStatus {
    return this.#status;
  }

  start(): void {
    if (this.#status !== "idle") {
      return;
    }
    void this.#connect();
  }

  /** Terminal: closes the connection and cancels any reconnect. */
  stop(reason = "stopped"): void {
    if (this.#status === "stopped") {
      return;
    }
    this.#teardownConnection();
    this.#setStatus("stopped", reason);
  }

  // ── Outbound (milestone 1: MSG/PRI/JCH/LCH) ────────────────────────────────

  /** Joins now if online; always remembered and rejoined after reconnects. */
  joinChannel(channel: string): void {
    this.#desiredChannels.add(channel);
    if (this.#status === "online") {
      this.#send({ cmd: "JCH", payload: { channel } });
    }
  }

  leaveChannel(channel: string): void {
    this.#desiredChannels.delete(channel);
    if (this.#status === "online") {
      this.#send({ cmd: "LCH", payload: { channel } });
    }
  }

  /** Resolves when the frame passed the flood gate onto the wire. */
  async sendChannelMessage(channel: string, message: string): Promise<void> {
    this.#assertOnline();
    this.#assertLength(message, this.state.vars.chat_max);
    await this.#rateGate.schedule("MSG", () => {
      this.#send({ cmd: "MSG", payload: { channel, message } });
    });
  }

  async sendPrivateMessage(recipient: string, message: string): Promise<void> {
    this.#assertOnline();
    this.#assertLength(message, this.state.vars.priv_max);
    await this.#rateGate.schedule("PRI", () => {
      this.#send({ cmd: "PRI", payload: { recipient, message } });
    });
  }

  #assertOnline(): void {
    if (this.#status !== "online") {
      throw new SessionNotOnlineError(this.#status);
    }
  }

  #assertLength(message: string, limitBytes: number): void {
    if (Buffer.byteLength(message, "utf8") > limitBytes) {
      throw new MessageTooLongError(limitBytes);
    }
  }

  // ── Connection lifecycle ───────────────────────────────────────────────────

  async #connect(): Promise<void> {
    this.#setStatus("acquiring_ticket");
    let ticket: string;
    try {
      ticket = await this.#tickets.getTicket();
    } catch (error) {
      if (
        error instanceof FlistAuthError ||
        error instanceof AccountLockedError
      ) {
        // Not retryable without the user: wrong password or locked vault.
        this.#log.warn({ err: error }, "ticket acquisition rejected");
        this.stop(error.message);
        return;
      }
      this.#log.warn({ err: error }, "ticket acquisition failed");
      this.#scheduleReconnect();
      return;
    }
    if (this.#status !== "acquiring_ticket") {
      return; // stopped while waiting for the ticket
    }

    this.#setStatus("connecting");
    const socket = new WebSocket(this.#wsUrl);
    this.#socket = socket;
    socket.on("open", () => {
      if (this.#socket !== socket) {
        return;
      }
      // Identify first or be disconnected.
      this.#setStatus("identifying");
      this.#send({
        cmd: "IDN",
        payload: {
          method: "ticket",
          account: this.accountName,
          ticket,
          character: this.character,
          cname: this.#clientName,
          cversion: this.#clientVersion,
        },
      });
      this.#resetWatchdog();
    });
    socket.on("message", (data) => {
      if (this.#socket !== socket) {
        return;
      }
      this.#handleFrame(rawDataToString(data));
    });
    socket.on("error", (error) => {
      this.#log.warn({ err: error }, "socket error");
    });
    socket.on("close", (code) => {
      if (this.#socket !== socket) {
        return;
      }
      this.#log.info({ code }, "connection closed");
      this.#scheduleReconnect();
    });
  }

  #handleFrame(raw: string): void {
    this.#resetWatchdog();
    const command = parseServerCommand(raw);
    if (!isKnownServerCommand(command)) {
      // Never crash on unknown commands: log and swallow.
      this.#log.warn({ cmd: command.cmd, raw }, "unknown server command");
      return;
    }
    switch (command.cmd) {
      case "PIN":
        this.#replyPin();
        return;
      case "IDN":
        this.state.apply(command);
        this.#attempt = 0;
        this.#setStatus("online");
        for (const channel of this.#desiredChannels) {
          this.#send({ cmd: "JCH", payload: { channel } });
        }
        this.events.emit("command", command);
        return;
      case "ERR":
        this.#handleError(command.payload.number);
        this.events.emit("command", command);
        return;
      default:
        this.state.apply(command);
        this.events.emit("command", command);
        return;
    }
  }

  #handleError(number: number): void {
    if (
      this.#status === "identifying" &&
      (number === FchatErrorCode.IdentificationFailed ||
        number === FchatErrorCode.UnknownAuthMethod)
    ) {
      // The cached ticket may have been invalidated account-wide by a newer
      // one. Drop it and reconnect with a fresh fetch; if the password itself
      // is stale, the TicketManager throws FlistAuthError and we stop.
      this.#log.warn({ number }, "identification rejected, dropping ticket");
      this.#tickets.invalidate();
      this.#scheduleReconnect();
      return;
    }
    this.#log.info({ number }, "server error");
  }

  #replyPin(): void {
    const now = Date.now();
    if (now - this.#lastPinSentAt < PIN_MIN_INTERVAL_MS) {
      // Answering would break the one-PIN-per-10s rule; the server pings
      // every 30s, so skipping an early duplicate is always safe.
      return;
    }
    this.#lastPinSentAt = now;
    this.#send({ cmd: "PIN" });
  }

  #scheduleReconnect(): void {
    this.#teardownConnection();
    if (this.#status === "stopped") {
      return;
    }
    const delay = backoffDelayMs(this.#attempt, this.#backoff);
    this.#attempt += 1;
    this.#setStatus(
      "backoff",
      `reconnecting in ${String(Math.round(delay))}ms`,
    );
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = undefined;
      void this.#connect();
    }, delay);
  }

  #teardownConnection(): void {
    if (this.#reconnectTimer) {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = undefined;
    }
    if (this.#watchdogTimer) {
      clearTimeout(this.#watchdogTimer);
      this.#watchdogTimer = undefined;
    }
    this.#rateGate.clear();
    this.state.resetVolatile();
    const socket = this.#socket;
    if (socket) {
      this.#socket = undefined;
      socket.removeAllListeners();
      socket.on("error", () => {});
      socket.terminate();
    }
  }

  #resetWatchdog(): void {
    if (this.#watchdogTimer) {
      clearTimeout(this.#watchdogTimer);
    }
    this.#watchdogTimer = setTimeout(() => {
      this.#watchdogTimer = undefined;
      this.#log.warn(
        { silenceMs: this.#watchdogMs },
        "watchdog: connection silent, reconnecting",
      );
      this.#scheduleReconnect();
    }, this.#watchdogMs);
  }

  #send(command: ClientCommand): void {
    if (this.#socket?.readyState === WebSocket.OPEN) {
      this.#socket.send(serializeClientCommand(command));
    }
  }

  #setStatus(status: SessionStatus, reason?: string): void {
    if (this.#status === status) {
      return;
    }
    this.#status = status;
    this.#log.info({ status, reason }, "session status");
    this.events.emit("status", { status, ...(reason ? { reason } : {}) });
  }
}
