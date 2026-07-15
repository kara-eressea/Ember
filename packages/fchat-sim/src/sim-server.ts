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
  parseFrame,
  serializeServerCommand,
  type ApiTicketResponse,
  type ClientCommand,
  type ClientCommandPayload,
  type ServerCommand,
  type ServerVars,
} from "@emberchat/fchat-protocol";
import { TicketService } from "./ticket-service.js";
import { DEFAULT_WORLD, type SimWorld } from "./world.js";

export interface FchatSimOptions {
  /** Port to listen on; 0 (default) picks a free port. */
  readonly port?: number;
  /** Bind address; loopback by default, "0.0.0.0" for the sim container. */
  readonly host?: string;
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
  /** Timestamp of the last client PIN of any kind (solicited reply or not). */
  lastClientPinAt: number;
  lastMsgAt: number;
  lastPriAt: number;
  lastLrpAt: number;
}

interface ChannelState {
  readonly name: string;
  readonly title: string;
  /** chat = MSG only, ads = LRP only, both = either. RMO changes it live. */
  mode: string;
  readonly official: boolean;
  /** In ORS listings. RST public/private flips this together with `open`. */
  listed: boolean;
  /** Joinable without an invite. Seeded rooms default open (a `listed:
   * false` seed stays joinable by exact name — deliberate leniency for the
   * hidden-join tests); CCR-created rooms start closed. */
  open: boolean;
  /** Characters invited via CIU — they may join while the room is closed. */
  readonly invited: Set<string>;
  description: string;
  oplist: string[];
  readonly members: Set<string>;
  /** Characters banned via CBU — JCH refuses with ERR 48 until CUB. */
  readonly banned: Set<string>;
  /** Character → timeout expiry (epoch ms). Expired entries are pruned on
   * the next join attempt. */
  readonly timeouts: Map<string, number>;
}

interface CharacterState {
  readonly gender: string;
  status: string;
  statusmsg: string;
  connection?: Connection;
}

const MAX_PING_MISSES = 3;
const UNSOLICITED_PIN_WINDOW_MS = 10_000;

/**
 * Parses an RLL dice expression per the documented grammar: up to 20 "+"-
 * joined terms, each "#d##" (1-9 dice of 1-500 sides) or a flat number up
 * to 10000 (modeled as sides 0). Undefined = malformed (RollError).
 */
function parseDice(
  dice: string,
): { count: number; sides: number }[] | undefined {
  const terms = dice.split("+");
  if (terms.length === 0 || terms.length > 20) {
    return undefined;
  }
  const rolls: { count: number; sides: number }[] = [];
  for (const term of terms) {
    const die = /^([1-9])d([1-9]\d{0,2})$/.exec(term);
    if (die) {
      const sides = Number(die[2]);
      if (sides > 500) {
        return undefined;
      }
      rolls.push({ count: Number(die[1]), sides });
      continue;
    }
    if (!/^\d{1,5}$/.test(term) || Number(term) > 10_000) {
      return undefined;
    }
    rolls.push({ count: Number(term), sides: 0 });
  }
  return rolls;
}

/** Best-effort extraction of the "method" field from a schema-invalid IDN. */
function extractIdnMethod(raw: string): unknown {
  const result = parseFrame(raw);
  if (
    !result.ok ||
    typeof result.frame.payload !== "object" ||
    result.frame.payload === null
  ) {
    return undefined;
  }
  return (result.frame.payload as Record<string, unknown>)["method"];
}

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
  readonly #host: string;
  readonly #log: (line: string) => void;
  readonly #tickets: TicketService;
  readonly #http: Server;
  readonly #wss: WebSocketServer;
  readonly #connections = new Set<Connection>();
  readonly #channels = new Map<string, ChannelState>();
  readonly #online = new Map<string, CharacterState>();
  /** Misbehavior toggle: stop sending server PINs. */
  dropPings = false;
  /** Misbehavior control: channels whose JCH fails with the mapped ERR. */
  readonly #joinRejections = new Map<string, number>();
  /** Counter behind CCR's minted ADH- ids. */
  #createdRooms = 0;
  /** Server-stored ignore lists (character → ignored names), like the real
   * server: they survive reconnects and are replayed via IGN init. */
  readonly #ignores = new Map<string, Set<string>>();
  #port: number | undefined;

  constructor(options: FchatSimOptions = {}) {
    this.#world = options.world ?? DEFAULT_WORLD;
    this.#vars = { ...DEFAULT_SERVER_VARS, ...options.serverVars };
    this.#pingIntervalMs = options.pingIntervalMs ?? 30_000;
    this.#lisBatchSize = options.lisBatchSize ?? 100;
    this.#requestedPort = options.port ?? 0;
    this.#host = options.host ?? "127.0.0.1";
    this.#log = options.log ?? (() => {});
    this.#tickets = new TicketService(this.#world.accounts);
    for (const seed of this.#world.channels) {
      this.#channels.set(seed.name, {
        name: seed.name,
        title: seed.title ?? seed.name,
        mode: seed.mode,
        official: !seed.name.startsWith("ADH-"),
        listed: seed.listed ?? true,
        open: true,
        invited: new Set(),
        description: seed.description,
        oplist: [...(seed.oplist ?? [""])],
        members: new Set(seed.npcs),
        banned: new Set(),
        timeouts: new Map(),
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
      this.#http.listen(this.#requestedPort, this.#host, () => {
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

  /** JCH for this channel fails with the given ERR (default: channel ban). */
  rejectJoins(
    channel: string,
    number: number = FchatErrorCode.BannedFromChannel,
  ): void {
    this.#joinRejections.set(channel, number);
  }

  allowJoins(channel: string): void {
    this.#joinRejections.delete(channel);
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
      lastClientPinAt: 0,
      lastMsgAt: 0,
      lastPriAt: 0,
      lastLrpAt: 0,
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
      if (command.cmd !== "IDN") {
        connection.socket.close();
        return;
      }
      if (!isKnownClientCommand(command)) {
        // An IDN that fails the schema still gets a diagnostic before the
        // close: ERR 33 for a non-ticket method, ERR 4 for anything else.
        const method = extractIdnMethod(raw);
        this.#sendError(
          connection,
          method !== undefined && method !== "ticket"
            ? FchatErrorCode.UnknownAuthMethod
            : FchatErrorCode.IdentificationFailed,
        );
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
    this.#send(connection, {
      cmd: "ADL",
      payload: { ops: [...(this.#world.chatops ?? [])] },
    });
    this.#send(connection, {
      cmd: "IGN",
      payload: {
        action: "init",
        characters: [...(this.#ignores.get(character) ?? [])],
      },
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
              .filter((channel) => !channel.official && channel.listed)
              .map((channel) => ({
                name: channel.name,
                characters: channel.members.size,
                title: channel.title,
              })),
          },
        });
        return;
      case "CCR":
        this.#handleCreateRoom(connection, character, command.payload.channel);
        return;
      case "CIU":
        this.#handleInvite(connection, character, command.payload);
        return;
      case "RST":
        this.#handleRoomStatus(connection, character, command.payload);
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
      case "LRP":
        this.#handleChannelAd(connection, character, command.payload);
        return;
      case "RLL":
        this.#handleRoll(connection, character, command.payload);
        return;
      case "RMO":
        this.#handleRoomMode(connection, character, command.payload);
        return;
      case "CKU":
        this.#handleKick(connection, character, command.payload);
        return;
      case "CBU":
        this.#handleBan(connection, character, command.payload);
        return;
      case "CTU":
        this.#handleTimeout(connection, character, command.payload);
        return;
      case "CUB":
        this.#handleUnban(connection, character, command.payload);
        return;
      case "COA":
        this.#handlePromote(connection, character, command.payload);
        return;
      case "COR":
        this.#handleDemote(connection, character, command.payload);
        return;
      case "CSO":
        this.#handleSetOwner(connection, character, command.payload);
        return;
      case "CDS":
        this.#handleSetDescription(connection, character, command.payload);
        return;
      case "CBL":
        this.#handleBanlist(connection, character, command.payload.channel);
        return;
      case "PRI":
        this.#handlePrivateMessage(connection, character, command.payload);
        return;
      case "IGN":
        this.#handleIgnore(connection, character, command.payload);
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
    const now = Date.now();
    if (connection.awaitingPong) {
      connection.awaitingPong = false;
      connection.missedPongs = 0;
      connection.lastClientPinAt = now;
      return;
    }
    // "Sending multiple pings within ten seconds will get you disconnected."
    // Any extra PIN within the window of a previous one — including a
    // legitimate solicited reply — counts, matching the documented rule.
    if (now - connection.lastClientPinAt < UNSOLICITED_PIN_WINDOW_MS) {
      connection.socket.close();
      return;
    }
    connection.lastClientPinAt = now;
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
    const rejection = this.#joinRejections.get(channelName);
    if (rejection !== undefined) {
      this.#sendError(connection, rejection);
      return;
    }
    if (channel.members.has(character)) {
      this.#sendError(connection, FchatErrorCode.AlreadyInChannel);
      return;
    }
    const timeoutUntil = channel.timeouts.get(character);
    if (timeoutUntil !== undefined && timeoutUntil <= Date.now()) {
      channel.timeouts.delete(character); // expired — prune and allow
    }
    if (channel.banned.has(character) || channel.timeouts.has(character)) {
      this.#sendError(connection, FchatErrorCode.BannedFromChannel);
      return;
    }
    if (
      !channel.open &&
      !channel.invited.has(character) &&
      !channel.oplist.includes(character)
    ) {
      this.#sendError(connection, FchatErrorCode.InviteRequired);
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

  /** CCR: the payload is the TITLE; the sim mints an ADH- id, makes the
   * creator owner, and walks them through the normal join flow. Created
   * rooms start closed and unlisted (invite-only) like the real server. */
  #handleCreateRoom(
    connection: Connection,
    character: string,
    title: string,
  ): void {
    this.#createdRooms += 1;
    const name = `ADH-sim${String(this.#createdRooms).padStart(4, "0")}`;
    this.#channels.set(name, {
      name,
      title,
      mode: "both",
      official: false,
      listed: false,
      open: false,
      invited: new Set(),
      description: "",
      oplist: [character],
      members: new Set(),
      banned: new Set(),
      timeouts: new Map(),
    });
    this.#handleJoin(connection, character, name);
  }

  #handleInvite(
    connection: Connection,
    character: string,
    payload: { channel: string; character: string },
  ): void {
    const channel = this.#channels.get(payload.channel);
    if (!channel) {
      this.#sendError(connection, FchatErrorCode.ChannelNotFound);
      return;
    }
    if (channel.official) {
      this.#sendError(connection, FchatErrorCode.CannotInviteToPublicChannel);
      return;
    }
    if (!channel.oplist.includes(character)) {
      // No dedicated "chanop required" code is documented; the real server
      // answers with a moderation error — 19 is the closest modeled one.
      this.#sendError(connection, FchatErrorCode.ModeratorRequired);
      return;
    }
    channel.invited.add(payload.character);
    const target = this.#online.get(payload.character)?.connection;
    if (target) {
      this.#send(target, {
        cmd: "CIU",
        payload: {
          sender: character,
          title: channel.title,
          name: channel.name,
        },
      });
    }
    this.#send(connection, {
      cmd: "SYS",
      payload: {
        message: `Your invitation to ${channel.title} has been sent to ${payload.character}.`,
      },
    });
  }

  #handleRoomStatus(
    connection: Connection,
    character: string,
    payload: { channel: string; status: "public" | "private" },
  ): void {
    const channel = this.#channels.get(payload.channel);
    // Official channels live outside the private-room namespace.
    if (!channel || channel.official) {
      this.#sendError(connection, FchatErrorCode.ChannelNotFound);
      return;
    }
    if (!channel.oplist.includes(character)) {
      this.#sendError(connection, FchatErrorCode.ModeratorRequired);
      return;
    }
    const open = payload.status === "public";
    channel.open = open;
    channel.listed = open;
    this.#send(connection, {
      cmd: "SYS",
      payload: {
        message: `${channel.title} is now ${open ? "open" : "invite-only"}.`,
        channel: channel.name,
      },
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
    if (!channel) {
      this.#sendError(connection, FchatErrorCode.ChannelNotFound);
      return;
    }
    if (!channel.members.has(character)) {
      this.#sendError(connection, FchatErrorCode.NotInChannel);
      return;
    }
    if (channel.mode === "ads") {
      this.#sendError(connection, FchatErrorCode.AdsOnlyChannel);
      return;
    }
    const now = Date.now();
    if (now - connection.lastMsgAt < this.#vars.msg_flood * 1000) {
      this.#sendError(connection, FchatErrorCode.MessageFlood);
      return;
    }
    if (Buffer.byteLength(payload.message, "utf8") > this.#vars.chat_max) {
      this.#sendError(connection, FchatErrorCode.MessageTooLong);
      return;
    }
    connection.lastMsgAt = now;
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

  /** LRP: like MSG, but on the lfrp pace/length and blocked in chat-only
   * rooms (the mirror of MSG being blocked in ads-only ones). */
  #handleChannelAd(
    connection: Connection,
    character: string,
    payload: { channel: string; message: string },
  ): void {
    const channel = this.#channels.get(payload.channel);
    if (!channel) {
      this.#sendError(connection, FchatErrorCode.ChannelNotFound);
      return;
    }
    if (!channel.members.has(character)) {
      this.#sendError(connection, FchatErrorCode.NotInChannel);
      return;
    }
    if (channel.mode === "chat") {
      this.#sendError(connection, FchatErrorCode.ChatOnlyChannel);
      return;
    }
    const now = Date.now();
    if (now - connection.lastLrpAt < this.#vars.lfrp_flood * 1000) {
      this.#sendError(connection, FchatErrorCode.AdFlood);
      return;
    }
    if (Buffer.byteLength(payload.message, "utf8") > this.#vars.lfrp_max) {
      this.#sendError(connection, FchatErrorCode.MessageTooLong);
      return;
    }
    connection.lastLrpAt = now;
    this.#broadcastToChannel(
      channel,
      {
        cmd: "LRP",
        payload: { character, message: payload.message, channel: channel.name },
      },
      character,
    );
  }

  /** RLL: the server computes the result and broadcasts it to everyone —
   * including the roller (unlike MSG/LRP, which are never echoed). */
  #handleRoll(
    connection: Connection,
    character: string,
    payload: { channel: string; dice: string },
  ): void {
    const channel = this.#channels.get(payload.channel);
    if (!channel) {
      this.#sendError(connection, FchatErrorCode.ChannelNotFound);
      return;
    }
    if (!channel.members.has(character)) {
      this.#sendError(connection, FchatErrorCode.NotInChannel);
      return;
    }
    if (payload.dice === "bottle") {
      const candidates = [...channel.members].filter(
        (member) => member !== character,
      );
      const target = candidates[Math.floor(Math.random() * candidates.length)];
      if (target === undefined) {
        this.#sendError(connection, FchatErrorCode.RollError);
        return;
      }
      this.#broadcastToChannel(channel, {
        cmd: "RLL",
        payload: {
          channel: channel.name,
          type: "bottle",
          message: `[b]${character}[/b] spins the bottle: [b]${target}[/b]`,
          character,
          target,
        },
      });
      return;
    }
    const rolls = parseDice(payload.dice);
    if (!rolls) {
      this.#sendError(connection, FchatErrorCode.RollError);
      return;
    }
    const results = rolls.map((roll) =>
      roll.sides === 0
        ? roll.count
        : Array.from(
            { length: roll.count },
            () => 1 + Math.floor(Math.random() * roll.sides),
          ).reduce((sum, value) => sum + value, 0),
    );
    const endresult = results.reduce((sum, value) => sum + value, 0);
    const breakdown =
      results.length > 1 ? `${results.map(String).join(" + ")} = ` : "";
    this.#broadcastToChannel(channel, {
      cmd: "RLL",
      payload: {
        channel: channel.name,
        type: "dice",
        message: `[b]${character}[/b] rolls ${payload.dice}: ${breakdown}[b]${String(endresult)}[/b]`,
        character,
        results,
        rolls: rolls.map((roll) =>
          roll.sides === 0
            ? String(roll.count)
            : `${String(roll.count)}d${String(roll.sides)}`,
        ),
        endresult,
      },
    });
  }

  /** Chanop check shared by the moderation handlers: channel op or global
   * chatop. Answers ERR 19 itself; returns the channel on success. */
  #requireOp(
    connection: Connection,
    character: string,
    channelName: string,
  ): ChannelState | undefined {
    const channel = this.#channels.get(channelName);
    if (!channel) {
      this.#sendError(connection, FchatErrorCode.ChannelNotFound);
      return undefined;
    }
    if (
      !channel.oplist.includes(character) &&
      !(this.#world.chatops ?? []).includes(character)
    ) {
      this.#sendError(connection, FchatErrorCode.ModeratorRequired);
      return undefined;
    }
    return channel;
  }

  /** Ops are shielded from kick/ban/timeout unless the actor is the owner
   * or a chatop — the real server answers with ERR 21. */
  #targetIsShielded(
    channel: ChannelState,
    actor: string,
    target: string,
  ): boolean {
    return (
      channel.oplist.includes(target) &&
      channel.oplist[0] !== actor &&
      !(this.#world.chatops ?? []).includes(actor)
    );
  }

  #handleKick(
    connection: Connection,
    character: string,
    payload: { channel: string; character: string },
  ): void {
    const channel = this.#requireOp(connection, character, payload.channel);
    if (!channel) {
      return;
    }
    if (!channel.members.has(payload.character)) {
      this.#sendError(connection, FchatErrorCode.CharacterNotInChannel);
      return;
    }
    if (this.#targetIsShielded(channel, character, payload.character)) {
      this.#sendError(connection, FchatErrorCode.CannotTargetModerator);
      return;
    }
    this.#broadcastToChannel(channel, {
      cmd: "CKU",
      payload: {
        operator: character,
        channel: channel.name,
        character: payload.character,
      },
    });
    // The invite (if any) survives: bans gate via the banned set, and an
    // unban or expired timeout lets an invited character straight back in.
    channel.members.delete(payload.character);
  }

  #handleBan(
    connection: Connection,
    character: string,
    payload: { channel: string; character: string },
  ): void {
    const channel = this.#requireOp(connection, character, payload.channel);
    if (!channel) {
      return;
    }
    if (channel.banned.has(payload.character)) {
      this.#sendError(connection, FchatErrorCode.AlreadyBannedFromChannel);
      return;
    }
    if (this.#targetIsShielded(channel, character, payload.character)) {
      this.#sendError(connection, FchatErrorCode.CannotTargetModerator);
      return;
    }
    channel.banned.add(payload.character);
    this.#broadcastToChannel(channel, {
      cmd: "CBU",
      payload: {
        operator: character,
        channel: channel.name,
        character: payload.character,
      },
    });
    // The invite (if any) survives: bans gate via the banned set, and an
    // unban or expired timeout lets an invited character straight back in.
    channel.members.delete(payload.character);
  }

  #handleTimeout(
    connection: Connection,
    character: string,
    payload: { channel: string; character: string; length: number },
  ): void {
    const channel = this.#requireOp(connection, character, payload.channel);
    if (!channel) {
      return;
    }
    if (this.#targetIsShielded(channel, character, payload.character)) {
      this.#sendError(connection, FchatErrorCode.CannotTargetModerator);
      return;
    }
    channel.timeouts.set(
      payload.character,
      Date.now() + payload.length * 60_000,
    );
    this.#broadcastToChannel(channel, {
      cmd: "CTU",
      payload: {
        operator: character,
        channel: channel.name,
        length: payload.length,
        character: payload.character,
      },
    });
    // The invite (if any) survives: bans gate via the banned set, and an
    // unban or expired timeout lets an invited character straight back in.
    channel.members.delete(payload.character);
  }

  #handleUnban(
    connection: Connection,
    character: string,
    payload: { channel: string; character: string },
  ): void {
    const channel = this.#requireOp(connection, character, payload.channel);
    if (!channel) {
      return;
    }
    if (!channel.banned.delete(payload.character)) {
      this.#sendError(connection, FchatErrorCode.NotBannedFromChannel);
      return;
    }
    this.#send(connection, {
      cmd: "SYS",
      payload: {
        message: `Channel ban removed on ${payload.character}.`,
        channel: channel.name,
      },
    });
  }

  #handlePromote(
    connection: Connection,
    character: string,
    payload: { channel: string; character: string },
  ): void {
    const channel = this.#requireOp(connection, character, payload.channel);
    if (!channel) {
      return;
    }
    if (channel.oplist.includes(payload.character)) {
      this.#send(connection, {
        cmd: "SYS",
        payload: {
          message: `${payload.character} is already a channel operator.`,
          channel: channel.name,
        },
      });
      return;
    }
    channel.oplist.push(payload.character);
    this.#broadcastToChannel(channel, {
      cmd: "COA",
      payload: { character: payload.character, channel: channel.name },
    });
  }

  #handleDemote(
    connection: Connection,
    character: string,
    payload: { channel: string; character: string },
  ): void {
    const channel = this.#requireOp(connection, character, payload.channel);
    if (!channel) {
      return;
    }
    const index = channel.oplist.indexOf(payload.character);
    if (index === -1) {
      this.#send(connection, {
        cmd: "SYS",
        payload: {
          message: `${payload.character} is not a channel operator.`,
          channel: channel.name,
        },
      });
      return;
    }
    // The owner slot is not a demotable op entry — CSO moves ownership.
    if (index === 0) {
      this.#sendError(connection, FchatErrorCode.CannotTargetModerator);
      return;
    }
    channel.oplist.splice(index, 1);
    this.#broadcastToChannel(channel, {
      cmd: "COR",
      payload: { character: payload.character, channel: channel.name },
    });
  }

  /** CSO: only the current owner (or a chatop) may hand the room over. */
  #handleSetOwner(
    connection: Connection,
    character: string,
    payload: { channel: string; character: string },
  ): void {
    const channel = this.#channels.get(payload.channel);
    if (!channel) {
      this.#sendError(connection, FchatErrorCode.ChannelNotFound);
      return;
    }
    if (
      channel.oplist[0] !== character &&
      !(this.#world.chatops ?? []).includes(character)
    ) {
      this.#sendError(connection, FchatErrorCode.ModeratorRequired);
      return;
    }
    channel.oplist = [
      payload.character,
      ...channel.oplist.slice(1).filter((op) => op !== payload.character),
    ];
    this.#broadcastToChannel(channel, {
      cmd: "CSO",
      payload: { character: payload.character, channel: channel.name },
    });
  }

  #handleSetDescription(
    connection: Connection,
    character: string,
    payload: { channel: string; description: string },
  ): void {
    const channel = this.#requireOp(connection, character, payload.channel);
    if (!channel) {
      return;
    }
    channel.description = payload.description;
    this.#broadcastToChannel(channel, {
      cmd: "CDS",
      payload: { channel: channel.name, description: payload.description },
    });
  }

  /** CBL has no dedicated response command — the list arrives as a SYS. */
  #handleBanlist(
    connection: Connection,
    character: string,
    channelName: string,
  ): void {
    const channel = this.#requireOp(connection, character, channelName);
    if (!channel) {
      return;
    }
    const names = [...channel.banned];
    this.#send(connection, {
      cmd: "SYS",
      payload: {
        message:
          names.length === 0
            ? `There are no bans set on ${channel.title}.`
            : `Channel bans for ${channel.title}: ${names.join(", ")}.`,
        channel: channel.name,
      },
    });
  }

  /** RMO: chanop changes which message kinds the room accepts. */
  #handleRoomMode(
    connection: Connection,
    character: string,
    payload: { channel: string; mode: "ads" | "both" | "chat" },
  ): void {
    const channel = this.#channels.get(payload.channel);
    if (!channel) {
      this.#sendError(connection, FchatErrorCode.ChannelNotFound);
      return;
    }
    if (!channel.oplist.includes(character)) {
      this.#sendError(connection, FchatErrorCode.ModeratorRequired);
      return;
    }
    channel.mode = payload.mode;
    this.#broadcastToChannel(channel, {
      cmd: "RMO",
      payload: { channel: channel.name, mode: payload.mode },
    });
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
    // "There is flood control; the same as the MSG command."
    const now = Date.now();
    if (now - connection.lastPriAt < this.#vars.msg_flood * 1000) {
      this.#sendError(connection, FchatErrorCode.MessageFlood);
      return;
    }
    if (Buffer.byteLength(payload.message, "utf8") > this.#vars.priv_max) {
      this.#sendError(connection, FchatErrorCode.MessageTooLong);
      return;
    }
    connection.lastPriAt = now;
    this.#send(target.connection, {
      cmd: "PRI",
      payload: { character, message: payload.message },
    });
  }

  #handleIgnore(
    connection: Connection,
    character: string,
    payload: ClientCommandPayload<"IGN">,
  ): void {
    switch (payload.action) {
      case "add": {
        let set = this.#ignores.get(character);
        if (!set) {
          set = new Set();
          this.#ignores.set(character, set);
        }
        set.add(payload.character);
        this.#send(connection, {
          cmd: "IGN",
          payload: { action: "add", character: payload.character },
        });
        return;
      }
      case "delete":
        this.#ignores.get(character)?.delete(payload.character);
        this.#send(connection, {
          cmd: "IGN",
          payload: { action: "delete", character: payload.character },
        });
        return;
      case "list":
        this.#send(connection, {
          cmd: "IGN",
          payload: {
            action: "init",
            characters: [...(this.#ignores.get(character) ?? [])],
          },
        });
        return;
      case "notify": {
        // The real server tells the ignored sender their PRI was dropped.
        const sender = this.#online.get(payload.character)?.connection;
        if (sender) {
          this.#sendError(sender, FchatErrorCode.IgnoredByRecipient);
        }
        return;
      }
    }
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
