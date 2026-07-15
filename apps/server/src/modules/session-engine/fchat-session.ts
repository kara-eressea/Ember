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
  type ClientSettableStatus,
  type TypingStatus,
} from "@emberchat/fchat-protocol";
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
/**
 * Consecutive IDN rejections (each with a freshly fetched ticket) before the
 * session stops instead of looping. A persistent rejection means the
 * character no longer exists on the account — retrying forever would churn
 * tickets, which invalidate account-wide and degrade sibling sessions.
 */
export const MAX_IDENTIFY_REJECTIONS = 3;
/** JCH sends without an echo before a channel is dropped from the desired
 * set. See #unconfirmedJoins. */
export const MAX_UNCONFIRMED_JOIN_ATTEMPTS = 2;

export interface BackoffOptions {
  readonly floorMs: number;
  readonly capMs: number;
  readonly random: () => number;
}

/**
 * Jittered exponential backoff: full jitter between the floor and an
 * exponential ceiling of floor·2^(attempt+1). Even the first retry is
 * jittered so a mass disconnect does not reconnect in lockstep. The result
 * never leaves [floorMs, capMs].
 */
export function backoffDelayMs(
  attempt: number,
  { floorMs, capMs, random }: BackoffOptions,
): number {
  const ceiling = Math.min(capMs, floorMs * 2 ** (attempt + 1));
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
  #identifyRejections = 0;
  /** Channels the user wants to be in; rejoined after every reconnect. */
  readonly #desiredChannels = new Set<string>();
  /**
   * JCH sends per channel that have no echo yet. ERR frames carry no channel
   * reference, so a refused join (banned, invite only, deleted) is detected
   * by its missing echo: a channel still unconfirmed after
   * MAX_UNCONFIRMED_JOIN_ATTEMPTS sends is dropped from the desired set
   * (decisions.md §9 — never fight a ban). Two attempts, not one, because a
   * connection can die with the echo in flight — a single mid-handshake drop
   * must not silently unsubscribe every channel. The ERRs still reach the
   * user via the event bus.
   */
  readonly #unconfirmedJoins = new Map<string, number>();
  /**
   * Our own LCH sends awaiting their echo. A self-LCH with no pending leave
   * is a kick/ban; one with a pending leave is just our echo — and must not
   * clobber the desired set, which a quick leave→rejoin may have re-added to.
   */
  readonly #pendingLeaves = new Map<string, number>();
  /** The user's chosen status — restored after every reconnect (F-Chat
   * resets a fresh connection to plain "online"). */
  #desiredStatus:
    { status: ClientSettableStatus; statusmsg: string } | undefined;
  /** Ignored senders (lowercased) already sent an IGN notify on this
   * connection — one courtesy frame per sender, not one per message. */
  readonly #notifiedIgnored = new Set<string>();
  /** Last TPN status sent per recipient (lowercased) — only changes go on
   * the wire; a keystroke storm must never become a TPN storm. */
  readonly #typingSent = new Map<string, TypingStatus>();

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
    // them separately; LRP paces on its own lfrp_flood (1/10 min live).
    // Both come from live VARs at send time, never hardcoded.
    this.#rateGate = new RateGate((cls) =>
      cls === "LRP" ? this.state.vars.lfrp_flood : this.state.vars.msg_flood,
    );
  }

  get status(): SessionStatus {
    return this.#status;
  }

  start(): void {
    if (this.#status !== "idle") {
      return;
    }
    this.#connectSafely();
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
      this.#unconfirmedJoins.set(
        channel,
        (this.#unconfirmedJoins.get(channel) ?? 0) + 1,
      );
      this.#send({ cmd: "JCH", payload: { channel } });
    }
  }

  leaveChannel(channel: string): void {
    this.#desiredChannels.delete(channel);
    this.#unconfirmedJoins.delete(channel);
    if (
      this.#status === "online" &&
      this.#send({ cmd: "LCH", payload: { channel } })
    ) {
      this.#pendingLeaves.set(
        channel,
        (this.#pendingLeaves.get(channel) ?? 0) + 1,
      );
    }
  }

  /**
   * Resolves when the frame passed the flood gate onto the wire; rejects if
   * the connection went away first (never a false "sent").
   */
  async sendChannelMessage(channel: string, message: string): Promise<void> {
    this.#assertOnline();
    this.#assertLength(message, this.state.vars.chat_max);
    await this.#rateGate.schedule("MSG", () => {
      if (!this.#send({ cmd: "MSG", payload: { channel, message } })) {
        throw new SessionNotOnlineError(this.#status);
      }
      this.events.emit("sent", { kind: "channel", channel, message });
    });
  }

  /** Sends a roleplay ad (LRP) — its own lfrp_max length and lfrp_flood
   * pace. The queue bound means a user can park at most a handful of ads;
   * at 10 minutes each that is deliberate back-pressure, not a bug. */
  async sendChannelAd(channel: string, message: string): Promise<void> {
    this.#assertOnline();
    this.#assertLength(message, this.state.vars.lfrp_max);
    await this.#rateGate.schedule("LRP", () => {
      if (!this.#send({ cmd: "LRP", payload: { channel, message } })) {
        throw new SessionNotOnlineError(this.#status);
      }
      this.events.emit("sent", { kind: "ad", channel, message });
    });
  }

  /**
   * Rolls dice or spins the bottle (RLL). No "sent" event: the server
   * computes the result and echoes the RLL back to us — persisting that
   * echo is the only truthful record. Rides the MSG pace.
   */
  async rollDice(channel: string, dice: string): Promise<void> {
    this.#assertOnline();
    await this.#rateGate.schedule("MSG", () => {
      if (!this.#send({ cmd: "RLL", payload: { channel, dice } })) {
        throw new SessionNotOnlineError(this.#status);
      }
    });
  }

  async sendPrivateMessage(recipient: string, message: string): Promise<void> {
    this.#assertOnline();
    this.#assertLength(message, this.state.vars.priv_max);
    await this.#rateGate.schedule("PRI", () => {
      if (!this.#send({ cmd: "PRI", payload: { recipient, message } })) {
        throw new SessionNotOnlineError(this.#status);
      }
      this.events.emit("sent", { kind: "pm", recipient, message });
    });
  }

  /**
   * Asks the server for both public channel listings (CHA + ORS). Resolves
   * when the frames passed the flood gate onto the wire; the responses
   * arrive as ordinary CHA/ORS commands on the event bus (the directory
   * cache subscribes there).
   */
  async requestChannelLists(): Promise<void> {
    this.#assertOnline();
    await Promise.all([
      this.#rateGate.schedule("CHA", () => {
        if (!this.#send({ cmd: "CHA" })) {
          throw new SessionNotOnlineError(this.#status);
        }
      }),
      this.#rateGate.schedule("ORS", () => {
        if (!this.#send({ cmd: "ORS" })) {
          throw new SessionNotOnlineError(this.#status);
        }
      }),
    ]);
  }

  /**
   * Creates a private, invite-only room (CCR). The payload is the TITLE —
   * the server mints the ADH- id and answers with a JCH into it, which
   * flows through the ordinary join/persist path; watch conversation
   * fan-out for the new key.
   */
  async createRoom(title: string): Promise<void> {
    this.#assertOnline();
    await this.#rateGate.schedule("ROOM", () => {
      if (!this.#send({ cmd: "CCR", payload: { channel: title } })) {
        throw new SessionNotOnlineError(this.#status);
      }
    });
  }

  /** Invites a character to a channel (CIU, chanop). The server answers
   * with a SYS; errors arrive as ERR — both already fan out. */
  async inviteToChannel(channel: string, character: string): Promise<void> {
    this.#assertOnline();
    await this.#rateGate.schedule("ROOM", () => {
      if (!this.#send({ cmd: "CIU", payload: { channel, character } })) {
        throw new SessionNotOnlineError(this.#status);
      }
    });
  }

  /** Sets a private room public (listed, freely joinable) or private
   * (unlisted, invite-only) — RST, owner/op only. */
  async setRoomStatus(
    channel: string,
    status: "public" | "private",
  ): Promise<void> {
    this.#assertOnline();
    await this.#rateGate.schedule("ROOM", () => {
      if (!this.#send({ cmd: "RST", payload: { channel, status } })) {
        throw new SessionNotOnlineError(this.#status);
      }
    });
  }

  /** What the character's status should read as right now. */
  get ownStatus(): { status: ClientSettableStatus; statusmsg: string } {
    return this.#desiredStatus ?? { status: "online", statusmsg: "" };
  }

  /**
   * PM typing telemetry (TPN). Best-effort by design: deduped per recipient
   * (only status changes are sent), silently dropped while not online —
   * typing state is never worth an error or a queue.
   */
  sendTyping(recipient: string, status: TypingStatus): void {
    if (this.#status !== "online") {
      return;
    }
    const key = recipient.toLowerCase();
    if (this.#typingSent.get(key) === status) {
      return;
    }
    this.#typingSent.set(key, status);
    // Through the gate like everything else user-triggered: dedup blocks
    // repeats, but alternating statuses would otherwise reach the wire at
    // socket speed (audit). Telemetry is droppable — a full or cleared
    // queue just loses a typing hint.
    this.#rateGate
      .schedule("TPN", () => {
        this.#send({ cmd: "TPN", payload: { character: recipient, status } });
      })
      .catch(() => {
        // Best-effort; the dedup map keeps intent for the next change.
      });
  }

  /** Adds a character to the server-side ignore list (IGN add). State and
   * persistence follow the server's acknowledgement, not the send. */
  async ignore(character: string): Promise<void> {
    this.#assertOnline();
    await this.#rateGate.schedule("IGN", () => {
      if (!this.#send({ cmd: "IGN", payload: { action: "add", character } })) {
        throw new SessionNotOnlineError(this.#status);
      }
    });
  }

  async unignore(character: string): Promise<void> {
    this.#assertOnline();
    await this.#rateGate.schedule("IGN", () => {
      if (
        !this.#send({ cmd: "IGN", payload: { action: "delete", character } })
      ) {
        throw new SessionNotOnlineError(this.#status);
      }
    });
  }

  /**
   * Sets the character's status (STA). Remembered and re-sent after every
   * reconnect.
   */
  async setStatus(
    status: ClientSettableStatus,
    statusmsg: string,
  ): Promise<void> {
    this.#assertOnline();
    await this.#pushStatus(status, statusmsg);
  }

  /**
   * Puts an STA on the wire and folds a synthetic self-echo into state and
   * onto the event bus, so every subscribed client (and later snapshots of
   * the member roster) converge without depending on the live server echoing
   * our own STA back — its echo, if any, is an idempotent overwrite.
   * #desiredStatus only moves once the frame was actually sent: a refused
   * send must not come back from the dead at the next reconnect.
   */
  #pushStatus(status: ClientSettableStatus, statusmsg: string): Promise<void> {
    return this.#rateGate.schedule("STA", () => {
      if (!this.#send({ cmd: "STA", payload: { status, statusmsg } })) {
        throw new SessionNotOnlineError(this.#status);
      }
      this.#desiredStatus = { status, statusmsg };
      const echo = {
        cmd: "STA",
        payload: { character: this.character, status, statusmsg },
      } as const;
      this.state.apply(echo);
      this.events.emit("command", echo);
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

  /**
   * #connect handles its expected failures itself; this backstop exists so
   * an unexpected throw (e.g. a misconfigured URL scheme rejected by the ws
   * constructor) becomes a logged reconnect cycle instead of an unhandled
   * rejection taking down the whole multi-tenant process.
   */
  #connectSafely(): void {
    this.#connect().catch((error: unknown) => {
      this.#log.error({ err: error }, "unexpected connect failure");
      this.#scheduleReconnect();
    });
  }

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
    // Without handshakeTimeout a host that accepts TCP but never completes
    // the upgrade would leave the session in `connecting` forever — no event
    // fires, so no watchdog or close handler can save it.
    const socket = new WebSocket(this.#wsUrl, {
      handshakeTimeout: this.#watchdogMs,
    });
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
      case "IDN": {
        this.state.apply(command);
        this.#attempt = 0;
        this.#identifyRejections = 0;
        this.#setStatus("online");
        // A disconnect voids any in-flight leave echo (FLN is a global LCH).
        this.#pendingLeaves.clear();
        // Rejoin the desired set — except channels the server has refused
        // MAX_UNCONFIRMED_JOIN_ATTEMPTS times (no echo ever came back).
        for (const channel of this.#desiredChannels) {
          const attempts = this.#unconfirmedJoins.get(channel) ?? 0;
          if (attempts >= MAX_UNCONFIRMED_JOIN_ATTEMPTS) {
            this.#log.info(
              { channel, attempts },
              "join never confirmed, giving up",
            );
            this.#desiredChannels.delete(channel);
            this.#unconfirmedJoins.delete(channel);
            continue;
          }
          this.#unconfirmedJoins.set(channel, attempts + 1);
          this.#send({ cmd: "JCH", payload: { channel } });
        }
        this.events.emit("command", command);
        // A fresh connection is plain "online" — restore the chosen status
        // (after the IDN event, so subscribers see the synthetic self-STA in
        // wire order).
        if (this.#desiredStatus) {
          const { status, statusmsg } = this.#desiredStatus;
          this.#pushStatus(status, statusmsg).catch((error: unknown) => {
            this.#log.warn({ err: error }, "status restore failed");
          });
        }
        return;
      }
      case "ERR":
        this.#handleError(command.payload.number);
        this.events.emit("command", command);
        return;
      case "PRI":
        // Ignoring is the client's responsibility (developer policy): tell
        // the server so it informs the sender. The message still flows to
        // the sink — history keeps it, clients hide it from render. Once per
        // sender per connection, through the gate: an ignored sender must
        // not be able to pace our outbound traffic 1:1 with their PMs.
        if (this.state.isIgnored(command.payload.character)) {
          const sender = command.payload.character.toLowerCase();
          if (!this.#notifiedIgnored.has(sender)) {
            this.#notifiedIgnored.add(sender);
            const character = command.payload.character;
            this.#rateGate
              .schedule("IGN", () => {
                this.#send({
                  cmd: "IGN",
                  payload: { action: "notify", character },
                });
              })
              .catch(() => {
                // Best-effort courtesy frame; a cleared/full gate drops it.
              });
          }
        }
        this.state.apply(command);
        this.events.emit("command", command);
        return;
      case "JCH":
        if (command.payload.character.identity === this.character) {
          // Our join echo: confirmed, safe to rejoin on future reconnects.
          this.#unconfirmedJoins.delete(command.payload.channel);
        }
        this.state.apply(command);
        this.events.emit("command", command);
        return;
      case "LCH": {
        if (command.payload.character === this.character) {
          const channel = command.payload.channel;
          const pendingLeaves = this.#pendingLeaves.get(channel) ?? 0;
          if (pendingLeaves > 0) {
            // The echo of our own leaveChannel() — which already forgot the
            // channel. Don't touch the desired set: a quick leave→rejoin may
            // have legitimately re-added it since.
            if (pendingLeaves === 1) {
              this.#pendingLeaves.delete(channel);
            } else {
              this.#pendingLeaves.set(channel, pendingLeaves - 1);
            }
          } else {
            // Server-initiated removal (kick/ban) — stop rejoining it on
            // reconnect.
            this.#desiredChannels.delete(channel);
            this.#unconfirmedJoins.delete(channel);
          }
        }
        this.state.apply(command);
        this.events.emit("command", command);
        return;
      }
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
      this.#identifyRejections += 1;
      if (this.#identifyRejections >= MAX_IDENTIFY_REJECTIONS) {
        // Fresh tickets keep being rejected: the character is gone or the
        // account is in a state the user must resolve. Looping would churn
        // tickets account-wide.
        this.stop(
          `identification rejected ${String(this.#identifyRejections)} times — check the character still exists`,
        );
        return;
      }
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
      this.#connectSafely();
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
    this.#notifiedIgnored.clear();
    this.#typingSent.clear();
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

  /** Returns false when the socket cannot take the frame (closing/closed). */
  #send(command: ClientCommand): boolean {
    if (this.#socket?.readyState === WebSocket.OPEN) {
      this.#socket.send(serializeClientCommand(command));
      return true;
    }
    return false;
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
