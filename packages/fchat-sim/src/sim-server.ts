// A local F-Chat mock: one HTTP server carrying both the WebSocket chat
// endpoint and a fake /json/getApiTicket.php. Speaks the protocol subset the
// bouncer needs (design/milestone-1-thin-vertical-slice.md step 3) with real
// server semantics where they matter: commands before IDN disconnect, only
// the newest ticket per account is valid, PIN discipline, and messages are
// not echoed back to their sender.

import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { WebSocketServer, WebSocket, type RawData } from "ws";
import {
  API_TICKET_PATH,
  DEFAULT_SERVER_VARS,
  FCHAT_ERROR_MESSAGES,
  FchatErrorCode,
  isClientCommandName,
  isKnownClientCommand,
  parseClientCommand,
  serializeServerCommand,
  type ApiTicketResponse,
  type ClientCommand,
  type ClientCommandPayload,
  type ServerCommand,
  type ServerVars,
} from "@emberline/fchat-protocol";
import { TicketService } from "./ticket-service.js";
import { DEFAULT_WORLD, type SimWorld } from "./world.js";

export interface FchatSimOptions {
  /** Port to listen on; 0 (default) picks a free port. */
  readonly port?: number;
  readonly world?: SimWorld;
  readonly serverVars?: Partial<ServerVars>;
  /** How often the sim pings clients. Real server: 30s. */
  readonly pingIntervalMs?: number;
  /** LIS is sent in batches of this many characters. */
  readonly lisBatchSize?: number;
  /** Log every frame in/out (used by the CLI). */
  readonly log?: (line: string) => void;
}

interface Connection {
  readonly socket: WebSocket;
  character?: string;
  account?: string;
  pingTimer?: NodeJS.Timeout;
  awaitingPong: boolean;
  missedPongs: number;
  lastUnsolicitedPinAt: number;
}

interface ChannelState {
  readonly name: string;
  readonly title: string;
  readonly mode: string;
  readonly official: boolean;
  description: string;
  oplist: readonly string[];
  readonly members: Set<string>;
}

interface CharacterState {
  readonly gender: string;
  status: string;
  statusmsg: string;
  connection?: Connection;
}

const MAX_PING_MISSES = 3;
const UNSOLICITED_PIN_WINDOW_MS = 10_000;

export function rawDataToString(data: RawData): string {
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString("utf8");
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString("utf8");
  }
  return data.toString("utf8");
}

export class FchatSim {
  readonly #world: SimWorld;
  readonly #vars: ServerVars;
  readonly #pingIntervalMs: number;
  readonly #lisBatchSize: number;
  readonly #requestedPort: number;
  readonly #log: (line: string) => void;
  readonly #tickets: TicketService;
  readonly #http: Server;
  readonly #wss: WebSocketServer;
  readonly #connections = new Set<Connection>();
  readonly #channels = new Map<string, ChannelState>();
  readonly #online = new Map<string, CharacterState>();
  /** Misbehavior toggle: stop sending server PINs. */
  dropPings = false;
  #port: number | undefined;

  constructor(options: FchatSimOptions = {}) {
    this.#world = options.world ?? DEFAULT_WORLD;
    this.#vars = { ...DEFAULT_SERVER_VARS, ...options.serverVars };
    this.#pingIntervalMs = options.pingIntervalMs ?? 30_000;
    this.#lisBatchSize = options.lisBatchSize ?? 100;
    this.#requestedPort = options.port ?? 0;
    this.#log = options.log ?? (() => {});
    this.#tickets = new TicketService(this.#world.accounts);
    for (const seed of this.#world.channels) {
      this.#channels.set(seed.name, {
        name: seed.name,
        title: seed.title ?? seed.name,
        mode: seed.mode,
        official: !seed.name.startsWith("ADH-"),
        description: seed.description,
        oplist: seed.oplist ?? [""],
        members: new Set(seed.npcs),
      });
    }
    for (const npc of this.#world.npcs) {
      this.#online.set(npc.name, {
        gender: npc.gender,
        status: npc.status,
        statusmsg: npc.statusmsg,
      });
    }
    this.#http = createServer((request, response) => {
      this.#handleHttp(request, response);
    });
    this.#wss = new WebSocketServer({ server: this.#http });
    this.#wss.on("connection", (socket) => {
      this.#handleConnection(socket);
    });
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.#http.once("error", reject);
      this.#http.listen(this.#requestedPort, "127.0.0.1", () => {
        this.#http.removeListener("error", reject);
        resolve();
      });
    });
    const address = this.#http.address();
    if (address === null || typeof address === "string") {
      throw new Error("fchat-sim: could not determine listening port");
    }
    this.#port = address.port;
  }

  async stop(): Promise<void> {
    for (const connection of [...this.#connections]) {
      this.#teardown(connection);
      connection.socket.terminate();
    }
    await new Promise<void>((resolve) => this.#wss.close(() => resolve()));
    await new Promise<void>((resolve, reject) => {
      this.#http.close((error) => (error ? reject(error) : resolve()));
    });
  }

  get port(): number {
    if (this.#port === undefined) {
      throw new Error("fchat-sim: not started");
    }
    return this.#port;
  }

  get httpUrl(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  get wsUrl(): string {
    return `ws://127.0.0.1:${this.port}/chat2`;
  }

  get ticketUrl(): string {
    return `${this.httpUrl}${API_TICKET_PATH}`;
  }

  /** Test convenience: issue a valid ticket without the HTTP round trip. */
  issueTicketFor(account: string): string {
    const known = this.#tickets.account(account);
    if (!known) {
      throw new Error(`fchat-sim: unknown account ${account}`);
    }
    const ticket = this.#tickets.issue(account, known.password);
    if (!ticket) {
      throw new Error(`fchat-sim: could not issue ticket for ${account}`);
    }
    return ticket;
  }

  // ── Misbehavior controls (testing-strategy.md) ────────────────────────────

  /** Abruptly drops a character's connection (no close frame semantics). */
  disconnect(character: string): void {
    this.#connectionFor(character).socket.terminate();
  }

  /** Sends an arbitrary raw frame — unknown commands, malformed JSON, etc. */
  sendRawTo(character: string, raw: string): void {
    this.#sendRaw(this.#connectionFor(character), raw);
  }

  sendErrorTo(character: string, number: number): void {
    this.#sendError(this.#connectionFor(character), number);
  }

  #connectionFor(character: string): Connection {
    const connection = this.#online.get(character)?.connection;
    if (!connection) {
      throw new Error(`fchat-sim: no connection for ${character}`);
    }
    return connection;
  }

  // ── HTTP: fake getApiTicket.php ───────────────────────────────────────────

  #handleHttp(request: IncomingMessage, response: ServerResponse): void {
    const url = new URL(request.url ?? "/", this.httpUrl);
    if (request.method !== "POST" || url.pathname !== API_TICKET_PATH) {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "Not found." }));
      return;
    }
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
      if (body.length > 65_536) {
        request.destroy();
      }
    });
    request.on("end", () => {
      const form = new URLSearchParams(body);
      const account = form.get("account") ?? "";
      const ticket = this.#tickets.issue(account, form.get("password") ?? "");
      let payload: ApiTicketResponse;
      if (!ticket) {
        payload = { error: "Invalid username or password." };
      } else {
        const characters = [
          ...(this.#tickets.account(account)?.characters ?? []),
        ];
        payload = {
          error: "",
          ticket,
          ...(form.get("no_characters") === "true"
            ? {}
            : { characters, default_character: characters[0] }),
          ...(form.get("no_friends") === "true" ? {} : { friends: [] }),
          ...(form.get("no_bookmarks") === "true" ? {} : { bookmarks: [] }),
        };
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(payload));
    });
  }

  // ── WebSocket ─────────────────────────────────────────────────────────────

  #handleConnection(socket: WebSocket): void {
    const connection: Connection = {
      socket,
      awaitingPong: false,
      missedPongs: 0,
      lastUnsolicitedPinAt: 0,
    };
    this.#connections.add(connection);
    socket.on("message", (data: RawData) => {
      this.#handleFrame(connection, rawDataToString(data));
    });
    socket.on("close", () => {
      this.#teardown(connection);
    });
    socket.on("error", () => {
      socket.terminate();
    });
  }

  #handleFrame(connection: Connection, raw: string): void {
    this.#log(`<< ${raw}`);
    // "The minimum size of a command is three characters. Commands under
    // this size will result in a disconnect."
    if (raw.length < 3) {
      connection.socket.close();
      return;
    }
    const command = parseClientCommand(raw);
    if (connection.character === undefined) {
      // "If you send any commands before identifying, you will be disconnected."
      if (command.cmd !== "IDN" || !isKnownClientCommand(command)) {
        connection.socket.close();
        return;
      }
      this.#identify(connection, command);
      return;
    }
    if (!isKnownClientCommand(command)) {
      // Unknown name → ERR 8; known name with a bad payload → ERR 1.
      this.#sendError(
        connection,
        isClientCommandName(command.cmd)
          ? FchatErrorCode.SyntaxError
          : FchatErrorCode.UnknownCommand,
      );
      return;
    }
    this.#dispatch(connection, command);
  }

  #identify(
    connection: Connection,
    command: { cmd: "IDN"; payload: ClientCommandPayload<"IDN"> },
  ): void {
    const { account, ticket, character } = command.payload;
    const known = this.#tickets.account(account);
    if (
      !known ||
      !this.#tickets.validate(account, ticket) ||
      !known.characters.includes(character)
    ) {
      this.#sendError(connection, FchatErrorCode.IdentificationFailed);
      connection.socket.close();
      return;
    }
    // Same character connecting again displaces the old connection.
    const existing = this.#online.get(character)?.connection;
    if (existing) {
      this.#sendError(existing, FchatErrorCode.LoggedInFromAnotherLocation);
      existing.socket.close();
      this.#teardown(existing);
    }
    connection.character = character;
    connection.account = account;
    this.#online.set(character, {
      gender: "None",
      status: "online",
      statusmsg: "",
      connection,
    });

    this.#send(connection, { cmd: "IDN", payload: { character } });
    this.#send(connection, {
      cmd: "HLO",
      payload: {
        message: "Welcome. Running fchat-sim. This is not the real F-Chat.",
      },
    });
    for (const frame of this.#varFrames()) {
      this.#send(connection, frame);
    }
    this.#send(connection, {
      cmd: "CON",
      payload: { count: this.#online.size },
    });
    const roster = [...this.#online.entries()].map(
      ([name, state]): [string, string, string, string] => [
        name,
        state.gender,
        state.status,
        state.statusmsg,
      ],
    );
    for (let i = 0; i < roster.length; i += this.#lisBatchSize) {
      this.#send(connection, {
        cmd: "LIS",
        payload: { characters: roster.slice(i, i + this.#lisBatchSize) },
      });
    }
    this.#broadcast({
      cmd: "NLN",
      payload: { identity: character, gender: "None", status: "online" },
    });
    this.#startPingCycle(connection);
  }

  #varFrames(): ServerCommand[] {
    const vars = this.#vars;
    return [
      { cmd: "VAR", payload: { variable: "chat_max", value: vars.chat_max } },
      { cmd: "VAR", payload: { variable: "priv_max", value: vars.priv_max } },
      { cmd: "VAR", payload: { variable: "lfrp_max", value: vars.lfrp_max } },
      {
        cmd: "VAR",
        payload: { variable: "lfrp_flood", value: vars.lfrp_flood },
      },
      { cmd: "VAR", payload: { variable: "msg_flood", value: vars.msg_flood } },
      // The real server sends this one as a string — mimic the quirk.
      {
        cmd: "VAR",
        payload: { variable: "permissions", value: String(vars.permissions) },
      },
      {
        cmd: "VAR",
        payload: {
          variable: "icon_blacklist",
          value: [...vars.icon_blacklist],
        },
      },
    ];
  }

  #dispatch(connection: Connection, command: ClientCommand): void {
    const character = connection.character;
    if (character === undefined) {
      return;
    }
    switch (command.cmd) {
      case "IDN":
        this.#sendError(connection, FchatErrorCode.AlreadyIdentified);
        return;
      case "PIN":
        this.#handleClientPin(connection);
        return;
      case "CHA":
        this.#send(connection, {
          cmd: "CHA",
          payload: {
            channels: [...this.#channels.values()]
              .filter((channel) => channel.official)
              .map((channel) => ({
                name: channel.name,
                mode: channel.mode,
                characters: channel.members.size,
              })),
          },
        });
        return;
      case "ORS":
        this.#send(connection, {
          cmd: "ORS",
          payload: {
            channels: [...this.#channels.values()]
              .filter((channel) => !channel.official)
              .map((channel) => ({
                name: channel.name,
                characters: channel.members.size,
                title: channel.title,
              })),
          },
        });
        return;
      case "JCH":
        this.#handleJoin(connection, character, command.payload.channel);
        return;
      case "LCH":
        this.#handleLeave(connection, character, command.payload.channel);
        return;
      case "MSG":
        this.#handleChannelMessage(connection, character, command.payload);
        return;
      case "PRI":
        this.#handlePrivateMessage(connection, character, command.payload);
        return;
      case "STA": {
        const state = this.#online.get(character);
        if (state) {
          state.status = command.payload.status;
          state.statusmsg = command.payload.statusmsg;
        }
        this.#broadcast({
          cmd: "STA",
          payload: {
            status: command.payload.status,
            character,
            statusmsg: command.payload.statusmsg,
          },
        });
        return;
      }
      case "TPN": {
        const target = this.#online.get(command.payload.character)?.connection;
        if (target) {
          this.#send(target, {
            cmd: "TPN",
            payload: { character, status: command.payload.status },
          });
        }
        return;
      }
    }
  }

  #handleClientPin(connection: Connection): void {
    if (connection.awaitingPong) {
      connection.awaitingPong = false;
      connection.missedPongs = 0;
      return;
    }
    // "Sending multiple pings within ten seconds will get you disconnected."
    const now = Date.now();
    if (now - connection.lastUnsolicitedPinAt < UNSOLICITED_PIN_WINDOW_MS) {
      connection.socket.close();
      return;
    }
    connection.lastUnsolicitedPinAt = now;
  }

  #handleJoin(
    connection: Connection,
    character: string,
    channelName: string,
  ): void {
    const channel = this.#channels.get(channelName);
    if (!channel) {
      this.#sendError(connection, FchatErrorCode.ChannelNotFound);
      return;
    }
    if (channel.members.has(character)) {
      this.#sendError(connection, FchatErrorCode.AlreadyInChannel);
      return;
    }
    channel.members.add(character);
    this.#broadcastToChannel(channel, {
      cmd: "JCH",
      payload: {
        channel: channel.name,
        character: { identity: character },
        title: channel.title,
      },
    });
    this.#send(connection, {
      cmd: "COL",
      payload: { channel: channel.name, oplist: [...channel.oplist] },
    });
    this.#send(connection, {
      cmd: "ICH",
      payload: {
        users: [...channel.members].map((identity) => ({ identity })),
        channel: channel.name,
        mode: channel.mode,
      },
    });
    this.#send(connection, {
      cmd: "CDS",
      payload: { channel: channel.name, description: channel.description },
    });
  }

  #handleLeave(
    connection: Connection,
    character: string,
    channelName: string,
  ): void {
    const channel = this.#channels.get(channelName);
    if (!channel) {
      this.#sendError(connection, FchatErrorCode.ChannelNotFound);
      return;
    }
    if (!channel.members.has(character)) {
      this.#sendError(connection, FchatErrorCode.CharacterNotInChannel);
      return;
    }
    this.#broadcastToChannel(channel, {
      cmd: "LCH",
      payload: { channel: channel.name, character },
    });
    channel.members.delete(character);
  }

  #handleChannelMessage(
    connection: Connection,
    character: string,
    payload: { channel: string; message: string },
  ): void {
    const channel = this.#channels.get(payload.channel);
    if (!channel || !channel.members.has(character)) {
      this.#sendError(connection, FchatErrorCode.NotInChannel);
      return;
    }
    if (Buffer.byteLength(payload.message, "utf8") > this.#vars.chat_max) {
      this.#sendError(connection, FchatErrorCode.MessageTooLong);
      return;
    }
    // The real server does not echo your own MSG back to you.
    this.#broadcastToChannel(
      channel,
      {
        cmd: "MSG",
        payload: { character, message: payload.message, channel: channel.name },
      },
      character,
    );
  }

  #handlePrivateMessage(
    connection: Connection,
    character: string,
    payload: { recipient: string; message: string },
  ): void {
    const target = this.#online.get(payload.recipient);
    if (!target?.connection) {
      this.#sendError(connection, FchatErrorCode.CharacterNotFound);
      return;
    }
    if (Buffer.byteLength(payload.message, "utf8") > this.#vars.priv_max) {
      this.#sendError(connection, FchatErrorCode.MessageTooLong);
      return;
    }
    this.#send(target.connection, {
      cmd: "PRI",
      payload: { character, message: payload.message },
    });
  }

  // ── PIN cycle ─────────────────────────────────────────────────────────────

  #startPingCycle(connection: Connection): void {
    connection.pingTimer = setInterval(() => {
      if (this.dropPings) {
        return;
      }
      if (connection.awaitingPong) {
        connection.missedPongs += 1;
        if (connection.missedPongs >= MAX_PING_MISSES) {
          connection.socket.close();
          return;
        }
      }
      connection.awaitingPong = true;
      this.#send(connection, { cmd: "PIN" });
    }, this.#pingIntervalMs);
  }

  // ── Plumbing ──────────────────────────────────────────────────────────────

  #teardown(connection: Connection): void {
    if (connection.pingTimer) {
      clearInterval(connection.pingTimer);
      connection.pingTimer = undefined;
    }
    this.#connections.delete(connection);
    const character = connection.character;
    if (character === undefined) {
      return;
    }
    connection.character = undefined;
    // Only remove presence if this connection still owns the character (it
    // may have been displaced by a newer login).
    if (this.#online.get(character)?.connection !== connection) {
      return;
    }
    this.#online.delete(character);
    for (const channel of this.#channels.values()) {
      channel.members.delete(character);
    }
    // FLN is "treated as a global LCH", so no per-channel LCH on disconnect.
    this.#broadcast({ cmd: "FLN", payload: { character } });
  }

  #send(connection: Connection, command: ServerCommand): void {
    this.#sendRaw(connection, serializeServerCommand(command));
  }

  #sendRaw(connection: Connection, raw: string): void {
    if (connection.socket.readyState === WebSocket.OPEN) {
      this.#log(`>> ${raw}`);
      connection.socket.send(raw);
    }
  }

  #sendError(connection: Connection, number: number): void {
    this.#send(connection, {
      cmd: "ERR",
      payload: {
        number,
        message: FCHAT_ERROR_MESSAGES[number] ?? "Unknown error.",
      },
    });
  }

  #broadcast(command: ServerCommand): void {
    for (const connection of this.#connections) {
      if (connection.character !== undefined) {
        this.#send(connection, command);
      }
    }
  }

  #broadcastToChannel(
    channel: ChannelState,
    command: ServerCommand,
    except?: string,
  ): void {
    for (const member of channel.members) {
      if (member === except) {
        continue;
      }
      const target = this.#online.get(member)?.connection;
      if (target) {
        this.#send(target, command);
      }
    }
  }
}
