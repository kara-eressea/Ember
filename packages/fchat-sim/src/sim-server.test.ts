import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import {
  apiTicketResponseSchema,
  parseServerCommand,
  serializeClientCommand,
  type ClientCommand,
} from "@emberchat/fchat-protocol";
import { FchatSim, rawDataToString } from "./sim-server.js";

class TestClient {
  readonly closed: Promise<void>;
  readonly #socket: WebSocket;
  readonly #queue: string[] = [];
  readonly #waiters: Array<(raw: string) => void> = [];

  private constructor(socket: WebSocket) {
    this.#socket = socket;
    socket.on("message", (data) => {
      const raw = rawDataToString(data);
      const waiter = this.#waiters.shift();
      if (waiter) {
        waiter(raw);
      } else {
        this.#queue.push(raw);
      }
    });
    this.closed = new Promise((resolve) =>
      socket.once("close", () => resolve()),
    );
  }

  static async connect(sim: FchatSim): Promise<TestClient> {
    const socket = new WebSocket(sim.wsUrl);
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    return new TestClient(socket);
  }

  sendRaw(raw: string): void {
    this.#socket.send(raw);
  }

  send(command: ClientCommand): void {
    this.sendRaw(serializeClientCommand(command));
  }

  /** Next raw frame, in arrival order. */
  async next(timeoutMs = 2000): Promise<string> {
    const queued = this.#queue.shift();
    if (queued !== undefined) {
      return queued;
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("timed out waiting for a frame")),
        timeoutMs,
      );
      this.#waiters.push((raw) => {
        clearTimeout(timer);
        resolve(raw);
      });
    });
  }

  /** Skips frames until one starts with the given command name. */
  async waitFor(cmd: string): Promise<string> {
    for (;;) {
      const raw = await this.next();
      if (raw === cmd || raw.startsWith(`${cmd} `)) {
        return raw;
      }
    }
  }

  pendingCount(): number {
    return this.#queue.length;
  }

  close(): void {
    this.#socket.close();
  }
}

const sims: FchatSim[] = [];

async function startSim(
  options: ConstructorParameters<typeof FchatSim>[0] = {},
): Promise<FchatSim> {
  const sim = new FchatSim(options);
  await sim.start();
  sims.push(sim);
  return sim;
}

afterEach(async () => {
  await Promise.all(sims.splice(0).map((sim) => sim.stop()));
});

function idn(
  account: string,
  ticket: string,
  character: string,
): ClientCommand {
  return {
    cmd: "IDN",
    payload: {
      method: "ticket",
      account,
      ticket,
      character,
      cname: "EmberChat",
      cversion: "0.0.0",
    },
  };
}

/** Connects and identifies, draining the handshake up to the own-NLN frame. */
async function login(
  sim: FchatSim,
  account: string,
  character: string,
): Promise<TestClient> {
  const client = await TestClient.connect(sim);
  client.send(idn(account, sim.issueTicketFor(account), character));
  await client.waitFor("NLN");
  return client;
}

describe("getApiTicket.php", () => {
  it("issues a ticket with the account's characters", async () => {
    const sim = await startSim();
    const response = await fetch(sim.ticketUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        account: "amber@example.test",
        password: "hunter2",
      }),
    });
    const body = apiTicketResponseSchema.parse(await response.json());
    expect(body).toMatchObject({
      error: "",
      characters: ["Amber Vale", "Cindral"],
      default_character: "Amber Vale",
      friends: [],
      bookmarks: [],
    });
    expect(body).toHaveProperty("ticket", expect.stringMatching(/^fct_/));
  });

  it("rejects bad credentials", async () => {
    const sim = await startSim();
    const response = await fetch(sim.ticketUrl, {
      method: "POST",
      body: new URLSearchParams({
        account: "amber@example.test",
        password: "wrong",
      }),
    });
    expect(await response.json()).toEqual({
      error: "Invalid username or password.",
    });
  });

  it("omits character data when no_characters is passed", async () => {
    const sim = await startSim();
    const response = await fetch(sim.ticketUrl, {
      method: "POST",
      body: new URLSearchParams({
        account: "amber@example.test",
        password: "hunter2",
        no_characters: "true",
      }),
    });
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).not.toHaveProperty("characters");
    expect(body).toHaveProperty("ticket");
  });
});

describe("login handshake", () => {
  it("walks IDN → HLO → VAR → CON → ADL → FRL → IGN → LIS → NLN in order", async () => {
    const sim = await startSim();
    const client = await TestClient.connect(sim);
    client.send(
      idn(
        "amber@example.test",
        sim.issueTicketFor("amber@example.test"),
        "Amber Vale",
      ),
    );

    expect(parseServerCommand(await client.next())).toEqual({
      cmd: "IDN",
      payload: { character: "Amber Vale" },
    });
    expect(parseServerCommand(await client.next())).toMatchObject({
      cmd: "HLO",
    });
    const varNames: string[] = [];
    for (let i = 0; i < 7; i += 1) {
      const command = parseServerCommand(await client.next());
      expect(command.cmd).toBe("VAR");
      if ("payload" in command && command.cmd === "VAR") {
        varNames.push(command.payload.variable);
      }
    }
    expect(varNames).toEqual([
      "chat_max",
      "priv_max",
      "lfrp_max",
      "lfrp_flood",
      "msg_flood",
      "permissions",
      "icon_blacklist",
    ]);
    const con = parseServerCommand(await client.next());
    expect(con).toEqual({ cmd: "CON", payload: { count: 4 } });
    // The chatop roster (M6) — the default world has none.
    expect(parseServerCommand(await client.next())).toEqual({
      cmd: "ADL",
      payload: { ops: [] },
    });
    // Friends+bookmarks union (M6 step 7) — none seeded for this account.
    expect(parseServerCommand(await client.next())).toEqual({
      cmd: "FRL",
      payload: { characters: [] },
    });
    // The ignore list replays before the roster (real-server order).
    expect(parseServerCommand(await client.next())).toEqual({
      cmd: "IGN",
      payload: { action: "init", characters: [] },
    });
    const lis = parseServerCommand(await client.next());
    expect(lis.cmd).toBe("LIS");
    if (lis.cmd === "LIS" && "payload" in lis) {
      const names = lis.payload.characters.map(([name]) => name);
      expect(names).toContain("Nyx Firemane");
      expect(names).toContain("Amber Vale");
      expect(names).toHaveLength(4);
    }
    expect(parseServerCommand(await client.next())).toEqual({
      cmd: "NLN",
      payload: { identity: "Amber Vale", gender: "None", status: "online" },
    });
  });

  it("sends LIS in batches sized by lisBatchSize", async () => {
    const sim = await startSim({ lisBatchSize: 2 });
    const client = await TestClient.connect(sim);
    client.send(
      idn(
        "amber@example.test",
        sim.issueTicketFor("amber@example.test"),
        "Amber Vale",
      ),
    );
    await client.waitFor("IGN"); // init sits between CON and the LIS batches
    const first = parseServerCommand(await client.next());
    const second = parseServerCommand(await client.next());
    expect(first).toMatchObject({ cmd: "LIS" });
    expect(second).toMatchObject({ cmd: "LIS" });
    if (first.cmd === "LIS" && "payload" in first) {
      expect(first.payload.characters).toHaveLength(2);
    }
  });

  it("rejects an invalidated ticket (newer ticket wins)", async () => {
    const sim = await startSim();
    const oldTicket = sim.issueTicketFor("amber@example.test");
    const newTicket = sim.issueTicketFor("amber@example.test");

    const stale = await TestClient.connect(sim);
    stale.send(idn("amber@example.test", oldTicket, "Amber Vale"));
    expect(parseServerCommand(await stale.next())).toEqual({
      cmd: "ERR",
      payload: { number: 4, message: "Identification failed." },
    });
    await stale.closed;

    const fresh = await TestClient.connect(sim);
    fresh.send(idn("amber@example.test", newTicket, "Amber Vale"));
    expect(parseServerCommand(await fresh.next())).toEqual({
      cmd: "IDN",
      payload: { character: "Amber Vale" },
    });
  });

  it("rejects a character that does not belong to the account", async () => {
    const sim = await startSim();
    const client = await TestClient.connect(sim);
    client.send(
      idn(
        "amber@example.test",
        sim.issueTicketFor("amber@example.test"),
        "Birch Rowan",
      ),
    );
    expect(parseServerCommand(await client.next())).toMatchObject({
      cmd: "ERR",
      payload: { number: 4 },
    });
    await client.closed;
  });

  it("disconnects clients that send commands before identifying", async () => {
    const sim = await startSim();
    const client = await TestClient.connect(sim);
    client.send({ cmd: "CHA" });
    await client.closed;
  });

  it("displaces an existing connection when the character logs in again", async () => {
    const sim = await startSim();
    const first = await login(sim, "amber@example.test", "Amber Vale");
    const second = await login(sim, "amber@example.test", "Amber Vale");
    expect(parseServerCommand(await first.waitFor("ERR"))).toMatchObject({
      payload: { number: 31 },
    });
    await first.closed;
    second.close();
  });

  it("broadcasts FLN then NLN to third parties when a character is displaced", async () => {
    const sim = await startSim();
    await login(sim, "amber@example.test", "Amber Vale");
    const observer = await login(sim, "birch@example.test", "Birch Rowan");
    await login(sim, "amber@example.test", "Amber Vale");
    expect(parseServerCommand(await observer.waitFor("FLN"))).toEqual({
      cmd: "FLN",
      payload: { character: "Amber Vale" },
    });
    expect(parseServerCommand(await observer.waitFor("NLN"))).toMatchObject({
      payload: { identity: "Amber Vale" },
    });
  });

  it("answers a second IDN after login with ERR 11", async () => {
    const sim = await startSim();
    const client = await login(sim, "amber@example.test", "Amber Vale");
    client.send(
      idn(
        "amber@example.test",
        sim.issueTicketFor("amber@example.test"),
        "Amber Vale",
      ),
    );
    expect(parseServerCommand(await client.waitFor("ERR"))).toMatchObject({
      payload: { number: 11 },
    });
  });

  it("answers a pre-login IDN with an unknown auth method with ERR 33 and closes", async () => {
    const sim = await startSim();
    const client = await TestClient.connect(sim);
    client.sendRaw(
      'IDN {"method":"apiKey","account":"amber@example.test","ticket":"x","character":"Amber Vale","cname":"EmberChat","cversion":"0.0.0"}',
    );
    expect(parseServerCommand(await client.next())).toMatchObject({
      cmd: "ERR",
      payload: { number: 33 },
    });
    await client.closed;
  });

  it("answers a structurally invalid IDN with ERR 4 and closes", async () => {
    const sim = await startSim();
    const client = await TestClient.connect(sim);
    client.sendRaw('IDN {"method":"ticket"}');
    expect(parseServerCommand(await client.next())).toMatchObject({
      cmd: "ERR",
      payload: { number: 4 },
    });
    await client.closed;
  });

  it("invalidates previous tickets when a new one is issued over HTTP", async () => {
    const sim = await startSim();
    const fetchTicket = async (): Promise<string> => {
      const response = await fetch(sim.ticketUrl, {
        method: "POST",
        body: new URLSearchParams({
          account: "amber@example.test",
          password: "hunter2",
        }),
      });
      const body = (await response.json()) as { ticket: string };
      return body.ticket;
    };
    const oldTicket = await fetchTicket();
    const newTicket = await fetchTicket();

    const stale = await TestClient.connect(sim);
    stale.send(idn("amber@example.test", oldTicket, "Amber Vale"));
    expect(parseServerCommand(await stale.next())).toMatchObject({
      cmd: "ERR",
      payload: { number: 4 },
    });
    await stale.closed;

    const fresh = await TestClient.connect(sim);
    fresh.send(idn("amber@example.test", newTicket, "Amber Vale"));
    expect(parseServerCommand(await fresh.next())).toMatchObject({
      cmd: "IDN",
    });
  });
});

describe("channels", () => {
  it("answers CHA with official channels and ORS with private rooms", async () => {
    const sim = await startSim();
    const client = await login(sim, "amber@example.test", "Amber Vale");
    client.send({ cmd: "CHA" });
    const cha = parseServerCommand(await client.waitFor("CHA"));
    expect(cha).toMatchObject({
      cmd: "CHA",
      payload: {
        channels: [
          { name: "Frontpage", mode: "chat", characters: 3 },
          { name: "Development", mode: "both", characters: 1 },
          { name: "Gardening", mode: "chat", characters: 1 },
          { name: "Terrarium", mode: "both", characters: 0 },
          { name: "Orchard", mode: "chat", characters: 1 },
        ],
      },
    });
    client.send({ cmd: "ORS" });
    const ors = parseServerCommand(await client.waitFor("ORS"));
    // Root Cellar (listed: false) must NOT appear — hidden rooms are
    // joinable by exact id only.
    expect(ors).toMatchObject({
      cmd: "ORS",
      payload: {
        channels: [
          {
            name: "ADH-1a2b3c4d5e6f7a8b9c0d",
            characters: 1,
            title: "Ember Lounge",
          },
        ],
      },
    });
  });

  it("keeps hidden rooms out of ORS but joinable by exact id", async () => {
    const sim = await startSim();
    const client = await login(sim, "amber@example.test", "Amber Vale");
    client.send({
      cmd: "JCH",
      payload: { channel: "ADH-9f8e7d6c5b4a39281706" },
    });
    expect(parseServerCommand(await client.waitFor("JCH"))).toMatchObject({
      cmd: "JCH",
      payload: {
        channel: "ADH-9f8e7d6c5b4a39281706",
        title: "Root Cellar",
      },
    });
  });

  it("replies to JCH with JCH, COL, ICH, and CDS", async () => {
    const sim = await startSim();
    const client = await login(sim, "amber@example.test", "Amber Vale");
    client.send({ cmd: "JCH", payload: { channel: "Frontpage" } });
    expect(parseServerCommand(await client.next())).toEqual({
      cmd: "JCH",
      payload: {
        channel: "Frontpage",
        character: { identity: "Amber Vale" },
        title: "Frontpage",
      },
    });
    expect(parseServerCommand(await client.next())).toEqual({
      cmd: "COL",
      payload: { channel: "Frontpage", oplist: ["", "Nyx Firemane"] },
    });
    const ich = parseServerCommand(await client.next());
    expect(ich).toMatchObject({
      cmd: "ICH",
      payload: { channel: "Frontpage", mode: "chat" },
    });
    if (ich.cmd === "ICH" && "payload" in ich) {
      expect(ich.payload.users).toContainEqual({ identity: "Amber Vale" });
      expect(ich.payload.users).toContainEqual({ identity: "Nyx Firemane" });
    }
    expect(parseServerCommand(await client.next())).toMatchObject({
      cmd: "CDS",
      payload: { channel: "Frontpage" },
    });
  });

  it("broadcasts JCH and LCH to other members", async () => {
    const sim = await startSim();
    const amber = await login(sim, "amber@example.test", "Amber Vale");
    const birch = await login(sim, "birch@example.test", "Birch Rowan");
    amber.send({ cmd: "JCH", payload: { channel: "Development" } });
    await amber.waitFor("CDS");

    birch.send({ cmd: "JCH", payload: { channel: "Development" } });
    expect(parseServerCommand(await amber.waitFor("JCH"))).toEqual({
      cmd: "JCH",
      payload: {
        channel: "Development",
        character: { identity: "Birch Rowan" },
        title: "Development",
      },
    });

    birch.send({ cmd: "LCH", payload: { channel: "Development" } });
    expect(parseServerCommand(await amber.waitFor("LCH"))).toEqual({
      cmd: "LCH",
      payload: { channel: "Development", character: "Birch Rowan" },
    });
  });

  it("rejects joining an unknown or already-joined channel", async () => {
    const sim = await startSim();
    const client = await login(sim, "amber@example.test", "Amber Vale");
    client.send({ cmd: "JCH", payload: { channel: "Nowhere" } });
    expect(parseServerCommand(await client.waitFor("ERR"))).toMatchObject({
      payload: { number: 26 },
    });
    client.send({ cmd: "JCH", payload: { channel: "Frontpage" } });
    await client.waitFor("CDS");
    client.send({ cmd: "JCH", payload: { channel: "Frontpage" } });
    expect(parseServerCommand(await client.waitFor("ERR"))).toMatchObject({
      payload: { number: 28 },
    });
  });

  it("rejects LCH for unknown channels and channels not joined", async () => {
    const sim = await startSim();
    const client = await login(sim, "amber@example.test", "Amber Vale");
    client.send({ cmd: "LCH", payload: { channel: "Nowhere" } });
    expect(parseServerCommand(await client.waitFor("ERR"))).toMatchObject({
      payload: { number: 26 },
    });
    client.send({ cmd: "LCH", payload: { channel: "Frontpage" } });
    expect(parseServerCommand(await client.waitFor("ERR"))).toMatchObject({
      payload: { number: 49 },
    });
  });
});

describe("messages", () => {
  it("relays MSG to other members but never echoes to the sender", async () => {
    const sim = await startSim();
    const amber = await login(sim, "amber@example.test", "Amber Vale");
    const birch = await login(sim, "birch@example.test", "Birch Rowan");
    for (const client of [amber, birch]) {
      client.send({ cmd: "JCH", payload: { channel: "Frontpage" } });
      await client.waitFor("CDS");
    }
    await amber.waitFor("JCH"); // Birch's join

    amber.send({
      cmd: "MSG",
      payload: { channel: "Frontpage", message: "héllo 世界 🦊" },
    });
    expect(parseServerCommand(await birch.waitFor("MSG"))).toEqual({
      cmd: "MSG",
      payload: {
        character: "Amber Vale",
        message: "héllo 世界 🦊",
        channel: "Frontpage",
      },
    });
    // Deterministic no-echo check: an echo of Amber's own MSG would have been
    // sent before Birch's reply, so Amber's next frame must be the reply.
    birch.send({
      cmd: "MSG",
      payload: { channel: "Frontpage", message: "hi back" },
    });
    expect(parseServerCommand(await amber.next())).toEqual({
      cmd: "MSG",
      payload: {
        character: "Birch Rowan",
        message: "hi back",
        channel: "Frontpage",
      },
    });
  });

  it("rejects MSG to a channel the sender has not joined", async () => {
    const sim = await startSim();
    const client = await login(sim, "amber@example.test", "Amber Vale");
    client.send({
      cmd: "MSG",
      payload: { channel: "Frontpage", message: "hi" },
    });
    expect(parseServerCommand(await client.waitFor("ERR"))).toMatchObject({
      payload: { number: 45 },
    });
  });

  it("rejects MSG to a nonexistent channel with ERR 26", async () => {
    const sim = await startSim();
    const client = await login(sim, "amber@example.test", "Amber Vale");
    client.send({ cmd: "MSG", payload: { channel: "Nowhere", message: "hi" } });
    expect(parseServerCommand(await client.waitFor("ERR"))).toMatchObject({
      payload: { number: 26 },
    });
  });

  it("enforces msg_flood with ERR 5 and recovers after the window", async () => {
    const sim = await startSim({ serverVars: { msg_flood: 0.05 } });
    const amber = await login(sim, "amber@example.test", "Amber Vale");
    const birch = await login(sim, "birch@example.test", "Birch Rowan");
    for (const client of [amber, birch]) {
      client.send({ cmd: "JCH", payload: { channel: "Frontpage" } });
      await client.waitFor("CDS");
    }
    amber.send({
      cmd: "MSG",
      payload: { channel: "Frontpage", message: "one" },
    });
    amber.send({
      cmd: "MSG",
      payload: { channel: "Frontpage", message: "two" },
    });
    expect(parseServerCommand(await amber.waitFor("ERR"))).toMatchObject({
      payload: { number: 5 },
    });
    expect(parseServerCommand(await birch.waitFor("MSG"))).toMatchObject({
      payload: { message: "one" },
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    amber.send({
      cmd: "MSG",
      payload: { channel: "Frontpage", message: "three" },
    });
    expect(parseServerCommand(await birch.waitFor("MSG"))).toMatchObject({
      payload: { message: "three" },
    });
  });

  it("applies the same flood control to PRI", async () => {
    const sim = await startSim();
    const amber = await login(sim, "amber@example.test", "Amber Vale");
    const birch = await login(sim, "birch@example.test", "Birch Rowan");
    amber.send({
      cmd: "PRI",
      payload: { recipient: "Birch Rowan", message: "one" },
    });
    amber.send({
      cmd: "PRI",
      payload: { recipient: "Birch Rowan", message: "two" },
    });
    expect(parseServerCommand(await amber.waitFor("ERR"))).toMatchObject({
      payload: { number: 5 },
    });
    expect(parseServerCommand(await birch.waitFor("PRI"))).toMatchObject({
      payload: { message: "one" },
    });
  });

  it("enforces priv_max with ERR 15", async () => {
    const sim = await startSim({ serverVars: { priv_max: 8 } });
    const amber = await login(sim, "amber@example.test", "Amber Vale");
    await login(sim, "birch@example.test", "Birch Rowan");
    amber.send({
      cmd: "PRI",
      payload: { recipient: "Birch Rowan", message: "way too long" },
    });
    expect(parseServerCommand(await amber.waitFor("ERR"))).toMatchObject({
      payload: { number: 15 },
    });
  });

  it("enforces chat_max with ERR 15", async () => {
    const sim = await startSim({ serverVars: { chat_max: 8 } });
    const client = await login(sim, "amber@example.test", "Amber Vale");
    client.send({ cmd: "JCH", payload: { channel: "Frontpage" } });
    await client.waitFor("CDS");
    client.send({
      cmd: "MSG",
      payload: { channel: "Frontpage", message: "way too long" },
    });
    expect(parseServerCommand(await client.waitFor("ERR"))).toMatchObject({
      payload: { number: 15 },
    });
  });

  it("delivers PRI to the recipient and errors for offline targets", async () => {
    const sim = await startSim();
    const amber = await login(sim, "amber@example.test", "Amber Vale");
    const birch = await login(sim, "birch@example.test", "Birch Rowan");
    amber.send({
      cmd: "PRI",
      payload: { recipient: "Birch Rowan", message: "psst" },
    });
    expect(parseServerCommand(await birch.waitFor("PRI"))).toEqual({
      cmd: "PRI",
      payload: { character: "Amber Vale", message: "psst" },
    });
    amber.send({
      cmd: "PRI",
      payload: { recipient: "Nobody Here", message: "hello?" },
    });
    expect(parseServerCommand(await amber.waitFor("ERR"))).toMatchObject({
      payload: { number: 6 },
    });
  });

  it("forwards TPN and broadcasts STA", async () => {
    const sim = await startSim();
    const amber = await login(sim, "amber@example.test", "Amber Vale");
    const birch = await login(sim, "birch@example.test", "Birch Rowan");
    amber.send({
      cmd: "TPN",
      payload: { character: "Birch Rowan", status: "typing" },
    });
    expect(parseServerCommand(await birch.waitFor("TPN"))).toEqual({
      cmd: "TPN",
      payload: { character: "Amber Vale", status: "typing" },
    });
    amber.send({
      cmd: "STA",
      payload: { status: "looking", statusmsg: "Testing!" },
    });
    expect(parseServerCommand(await birch.waitFor("STA"))).toEqual({
      cmd: "STA",
      payload: {
        status: "looking",
        character: "Amber Vale",
        statusmsg: "Testing!",
      },
    });
  });
});

describe("protocol discipline", () => {
  it("answers unknown commands with ERR 8 and bad payloads with ERR 1", async () => {
    const sim = await startSim();
    const client = await login(sim, "amber@example.test", "Amber Vale");
    client.sendRaw('ZZZ {"foo": 1}');
    expect(parseServerCommand(await client.waitFor("ERR"))).toMatchObject({
      payload: { number: 8 },
    });
    client.sendRaw('STA {"status":"crown","statusmsg":""}');
    expect(parseServerCommand(await client.waitFor("ERR"))).toMatchObject({
      payload: { number: 1 },
    });
  });

  it("disconnects on frames under three characters", async () => {
    const sim = await startSim();
    const client = await login(sim, "amber@example.test", "Amber Vale");
    client.sendRaw("PI");
    await client.closed;
  });

  it("disconnects on repeated unsolicited client PINs", async () => {
    const sim = await startSim();
    const client = await login(sim, "amber@example.test", "Amber Vale");
    client.send({ cmd: "PIN" });
    client.send({ cmd: "PIN" });
    await client.closed;
  });

  it("pings on the configured interval and drops unresponsive clients", async () => {
    const sim = await startSim({ pingIntervalMs: 30 });
    const client = await login(sim, "amber@example.test", "Amber Vale");
    await client.waitFor("PIN");
    await client.closed; // never answered → dropped after 3 missed pongs
  });

  it("keeps responsive clients alive through several ping cycles", async () => {
    // 100ms interval → a 300ms liveness budget per reply, so a slow CI runner
    // does not get the client dropped for missing three consecutive pings.
    const sim = await startSim({ pingIntervalMs: 100 });
    const client = await login(sim, "amber@example.test", "Amber Vale");
    for (let i = 0; i < 4; i += 1) {
      await client.waitFor("PIN");
      client.send({ cmd: "PIN" });
    }
  });

  it("disconnects a client that sends an extra PIN alongside its reply", async () => {
    const sim = await startSim({ pingIntervalMs: 100 });
    const client = await login(sim, "amber@example.test", "Amber Vale");
    await client.waitFor("PIN");
    client.send({ cmd: "PIN" }); // legitimate solicited reply
    client.send({ cmd: "PIN" }); // duplicate within the 10s window
    await client.closed;
  });

  it("stops pinging when dropPings is set", async () => {
    const sim = await startSim({ pingIntervalMs: 30 });
    sim.dropPings = true;
    const client = await login(sim, "amber@example.test", "Amber Vale");
    await expect(client.next(300)).rejects.toThrow("timed out");
  });
});

describe("ignore lists", () => {
  it("stores IGN add/delete server-side, replays via init, and relays notify as ERR 20", async () => {
    const sim = await startSim();
    const amber = await login(sim, "amber@example.test", "Amber Vale");
    amber.send({
      cmd: "IGN",
      payload: { action: "add", character: "Cindral" },
    });
    expect(parseServerCommand(await amber.waitFor("IGN"))).toEqual({
      cmd: "IGN",
      payload: { action: "add", character: "Cindral" },
    });

    // The list is server-stored: a reconnect replays it via init.
    amber.close();
    await amber.closed;
    const back = await TestClient.connect(sim);
    back.send(
      idn(
        "amber@example.test",
        sim.issueTicketFor("amber@example.test"),
        "Amber Vale",
      ),
    );
    expect(parseServerCommand(await back.waitFor("IGN"))).toEqual({
      cmd: "IGN",
      payload: { action: "init", characters: ["Cindral"] },
    });
    await back.waitFor("NLN");

    // The sim never filters PRI — ignoring is the client's responsibility;
    // the client's `notify` makes the sim tell the sender via ERR 20.
    const cindral = await login(sim, "amber@example.test", "Cindral");
    cindral.send({
      cmd: "PRI",
      payload: { recipient: "Amber Vale", message: "hello?" },
    });
    expect(parseServerCommand(await back.waitFor("PRI"))).toEqual({
      cmd: "PRI",
      payload: { character: "Cindral", message: "hello?" },
    });
    back.send({
      cmd: "IGN",
      payload: { action: "notify", character: "Cindral" },
    });
    expect(parseServerCommand(await cindral.waitFor("ERR"))).toMatchObject({
      payload: { number: 20 },
    });

    // delete + list round-trip.
    back.send({
      cmd: "IGN",
      payload: { action: "delete", character: "Cindral" },
    });
    expect(parseServerCommand(await back.waitFor("IGN"))).toEqual({
      cmd: "IGN",
      payload: { action: "delete", character: "Cindral" },
    });
    back.send({ cmd: "IGN", payload: { action: "list" } });
    expect(parseServerCommand(await back.waitFor("IGN"))).toEqual({
      cmd: "IGN",
      payload: { action: "init", characters: [] },
    });
  });
});

describe("misbehavior controls", () => {
  it("drops a connection on demand and broadcasts FLN to the others", async () => {
    const sim = await startSim();
    const amber = await login(sim, "amber@example.test", "Amber Vale");
    const birch = await login(sim, "birch@example.test", "Birch Rowan");
    sim.disconnect("Birch Rowan");
    await birch.closed;
    expect(parseServerCommand(await amber.waitFor("FLN"))).toEqual({
      cmd: "FLN",
      payload: { character: "Birch Rowan" },
    });
  });

  it("injects raw frames and errors on demand", async () => {
    const sim = await startSim();
    const client = await login(sim, "amber@example.test", "Amber Vale");
    sim.sendRawTo("Amber Vale", 'QQQ {"chaos": true}');
    expect(await client.waitFor("QQQ")).toBe('QQQ {"chaos": true}');
    sim.sendErrorTo("Amber Vale", 62);
    expect(parseServerCommand(await client.waitFor("ERR"))).toMatchObject({
      payload: {
        number: 62,
        message: "There are currently no free login slots.",
      },
    });
  });
});

describe("private rooms (M6: CCR / CIU / RST)", () => {
  it("CCR mints an ADH- room, owner-first COL, closed and unlisted", async () => {
    const sim = await startSim();
    const amber = await login(sim, "amber@example.test", "Amber Vale");
    amber.send({ cmd: "CCR", payload: { channel: "Ember Attic" } });
    const jch = parseServerCommand(await amber.waitFor("JCH"));
    expect(jch).toMatchObject({
      cmd: "JCH",
      payload: {
        channel: "ADH-sim0001",
        title: "Ember Attic",
        character: { identity: "Amber Vale" },
      },
    });
    expect(parseServerCommand(await amber.waitFor("COL"))).toMatchObject({
      cmd: "COL",
      payload: { channel: "ADH-sim0001", oplist: ["Amber Vale"] },
    });
    // New rooms start unlisted…
    amber.send({ cmd: "ORS" });
    const ors = parseServerCommand(await amber.waitFor("ORS"));
    if (ors.cmd === "ORS" && "payload" in ors) {
      expect(ors.payload.channels.map((c) => c.name)).not.toContain(
        "ADH-sim0001",
      );
    }
    // …and closed: an uninvited character is refused with ERR 44.
    const birch = await login(sim, "birch@example.test", "Birch Rowan");
    birch.send({ cmd: "JCH", payload: { channel: "ADH-sim0001" } });
    expect(parseServerCommand(await birch.waitFor("ERR"))).toMatchObject({
      payload: { number: 44 },
    });
  });

  it("CIU delivers the invite and admits the invitee", async () => {
    const sim = await startSim();
    const amber = await login(sim, "amber@example.test", "Amber Vale");
    const birch = await login(sim, "birch@example.test", "Birch Rowan");
    amber.send({ cmd: "CCR", payload: { channel: "Ember Attic" } });
    await amber.waitFor("CDS");

    // A non-op cannot invite; official channels cannot be invited to.
    birch.send({
      cmd: "CIU",
      payload: { channel: "ADH-sim0001", character: "Amber Vale" },
    });
    expect(parseServerCommand(await birch.waitFor("ERR"))).toMatchObject({
      payload: { number: 19 },
    });
    amber.send({
      cmd: "CIU",
      payload: { channel: "Frontpage", character: "Birch Rowan" },
    });
    expect(parseServerCommand(await amber.waitFor("ERR"))).toMatchObject({
      payload: { number: 47 },
    });

    // The owner's invite reaches the target as CIU and admits them.
    amber.send({
      cmd: "CIU",
      payload: { channel: "ADH-sim0001", character: "Birch Rowan" },
    });
    expect(parseServerCommand(await birch.waitFor("CIU"))).toEqual({
      cmd: "CIU",
      payload: {
        sender: "Amber Vale",
        title: "Ember Attic",
        name: "ADH-sim0001",
      },
    });
    expect(parseServerCommand(await amber.waitFor("SYS"))).toMatchObject({
      payload: {
        message: "Your invitation to Ember Attic has been sent to Birch Rowan.",
      },
    });
    birch.send({ cmd: "JCH", payload: { channel: "ADH-sim0001" } });
    expect(parseServerCommand(await birch.waitFor("JCH"))).toMatchObject({
      payload: { channel: "ADH-sim0001", title: "Ember Attic" },
    });
  });

  it("RST public lists the room and opens it to everyone", async () => {
    const sim = await startSim();
    const amber = await login(sim, "amber@example.test", "Amber Vale");
    amber.send({ cmd: "CCR", payload: { channel: "Ember Attic" } });
    await amber.waitFor("CDS");
    amber.send({
      cmd: "RST",
      payload: { channel: "ADH-sim0001", status: "public" },
    });
    expect(parseServerCommand(await amber.waitFor("SYS"))).toMatchObject({
      payload: { message: "Ember Attic is now open." },
    });
    amber.send({ cmd: "ORS" });
    const ors = parseServerCommand(await amber.waitFor("ORS"));
    if (ors.cmd === "ORS" && "payload" in ors) {
      expect(ors.payload.channels.map((c) => c.name)).toContain("ADH-sim0001");
    }
    const birch = await login(sim, "birch@example.test", "Birch Rowan");
    birch.send({ cmd: "JCH", payload: { channel: "ADH-sim0001" } });
    expect(parseServerCommand(await birch.waitFor("JCH"))).toMatchObject({
      payload: { channel: "ADH-sim0001" },
    });
  });
});

describe("RP message types (M6: LRP / RLL / RMO)", () => {
  it("relays LRP to other members without echoing to the sender", async () => {
    const sim = await startSim();
    const amber = await login(sim, "amber@example.test", "Amber Vale");
    const birch = await login(sim, "birch@example.test", "Birch Rowan");
    for (const client of [amber, birch]) {
      client.send({ cmd: "JCH", payload: { channel: "Development" } });
      await client.waitFor("CDS");
    }
    await amber.waitFor("JCH"); // Birch's join
    amber.send({
      cmd: "LRP",
      payload: { channel: "Development", message: "Looking for a scene." },
    });
    expect(parseServerCommand(await birch.waitFor("LRP"))).toEqual({
      cmd: "LRP",
      payload: {
        character: "Amber Vale",
        message: "Looking for a scene.",
        channel: "Development",
      },
    });
    expect(amber.pendingCount()).toBe(0);
  });

  it("rejects LRP in a chat-only channel with ERR 59 and MSG in an ads-only room with ERR 60", async () => {
    const sim = await startSim();
    const amber = await login(sim, "amber@example.test", "Amber Vale");
    amber.send({ cmd: "JCH", payload: { channel: "Frontpage" } });
    await amber.waitFor("CDS");
    amber.send({
      cmd: "LRP",
      payload: { channel: "Frontpage", message: "an ad" },
    });
    expect(parseServerCommand(await amber.waitFor("ERR"))).toMatchObject({
      payload: { number: 59 },
    });
    // Create a room (owner), flip it to ads-only, and watch MSG bounce.
    amber.send({ cmd: "CCR", payload: { channel: "Ads Only Attic" } });
    await amber.waitFor("CDS");
    amber.send({
      cmd: "RMO",
      payload: { channel: "ADH-sim0001", mode: "ads" },
    });
    expect(parseServerCommand(await amber.waitFor("RMO"))).toEqual({
      cmd: "RMO",
      payload: { channel: "ADH-sim0001", mode: "ads" },
    });
    amber.send({
      cmd: "MSG",
      payload: { channel: "ADH-sim0001", message: "hello?" },
    });
    expect(parseServerCommand(await amber.waitFor("ERR"))).toMatchObject({
      payload: { number: 60 },
    });
  });

  it("rejects RMO from a non-op with ERR 19", async () => {
    const sim = await startSim();
    const amber = await login(sim, "amber@example.test", "Amber Vale");
    amber.send({ cmd: "JCH", payload: { channel: "Development" } });
    await amber.waitFor("CDS");
    amber.send({
      cmd: "RMO",
      payload: { channel: "Development", mode: "chat" },
    });
    expect(parseServerCommand(await amber.waitFor("ERR"))).toMatchObject({
      payload: { number: 19 },
    });
  });

  it("enforces the lfrp_flood pace with ERR 56", async () => {
    const sim = await startSim({ serverVars: { lfrp_flood: 600 } });
    const amber = await login(sim, "amber@example.test", "Amber Vale");
    amber.send({ cmd: "JCH", payload: { channel: "Development" } });
    await amber.waitFor("CDS");
    amber.send({
      cmd: "LRP",
      payload: { channel: "Development", message: "first ad" },
    });
    amber.send({
      cmd: "LRP",
      payload: { channel: "Development", message: "second ad" },
    });
    expect(parseServerCommand(await amber.waitFor("ERR"))).toMatchObject({
      payload: { number: 56 },
    });
  });

  it("computes dice rolls and echoes the RLL to the roller", async () => {
    const sim = await startSim();
    const amber = await login(sim, "amber@example.test", "Amber Vale");
    amber.send({ cmd: "JCH", payload: { channel: "Development" } });
    await amber.waitFor("CDS");
    amber.send({
      cmd: "RLL",
      payload: { channel: "Development", dice: "2d6+10" },
    });
    const roll = parseServerCommand(await amber.waitFor("RLL"));
    if (roll.cmd !== "RLL" || !("payload" in roll)) {
      throw new Error("RLL did not parse");
    }
    expect(roll.payload).toMatchObject({
      channel: "Development",
      type: "dice",
      character: "Amber Vale",
      rolls: ["2d6", "10"],
    });
    const results = roll.payload.results!;
    expect(results).toHaveLength(2);
    expect(results[0]).toBeGreaterThanOrEqual(2);
    expect(results[0]).toBeLessThanOrEqual(12);
    expect(results[1]).toBe(10);
    expect(roll.payload.endresult).toBe(results[0]! + 10);
    expect(roll.payload.message).toContain("[b]Amber Vale[/b] rolls 2d6+10:");
  });

  it("spins the bottle at another member and rejects spinning alone", async () => {
    const sim = await startSim();
    const amber = await login(sim, "amber@example.test", "Amber Vale");
    const birch = await login(sim, "birch@example.test", "Birch Rowan");
    amber.send({ cmd: "JCH", payload: { channel: "Terrarium" } });
    await amber.waitFor("CDS");
    amber.send({
      cmd: "RLL",
      payload: { channel: "Terrarium", dice: "bottle" },
    });
    expect(parseServerCommand(await amber.waitFor("ERR"))).toMatchObject({
      payload: { number: 36 },
    });
    birch.send({ cmd: "JCH", payload: { channel: "Terrarium" } });
    await birch.waitFor("CDS");
    amber.send({
      cmd: "RLL",
      payload: { channel: "Terrarium", dice: "bottle" },
    });
    expect(parseServerCommand(await birch.waitFor("RLL"))).toEqual({
      cmd: "RLL",
      payload: {
        channel: "Terrarium",
        type: "bottle",
        message: "[b]Amber Vale[/b] spins the bottle: [b]Birch Rowan[/b]",
        character: "Amber Vale",
        target: "Birch Rowan",
      },
    });
    await amber.waitFor("RLL"); // the roller sees it too
  });

  it("rejects malformed dice expressions with ERR 36", async () => {
    const sim = await startSim();
    const amber = await login(sim, "amber@example.test", "Amber Vale");
    amber.send({ cmd: "JCH", payload: { channel: "Development" } });
    await amber.waitFor("CDS");
    for (const dice of ["0d6", "1d501", "10001", "1d6+", "2x6"]) {
      amber.send({ cmd: "RLL", payload: { channel: "Development", dice } });
      expect(parseServerCommand(await amber.waitFor("ERR"))).toMatchObject({
        payload: { number: 36 },
      });
    }
  });
});

describe("channel moderation (M6: CKU / CBU / CTU / CUB / COA / COR / CSO / CDS / CBL)", () => {
  /** Amber creates a room (becoming owner) and Birch joins it. */
  async function roomWithTwo() {
    const sim = await startSim();
    const amber = await login(sim, "amber@example.test", "Amber Vale");
    amber.send({ cmd: "CCR", payload: { channel: "Mod Attic" } });
    await amber.waitFor("CDS");
    amber.send({
      cmd: "CIU",
      payload: { channel: "ADH-sim0001", character: "Birch Rowan" },
    });
    await amber.waitFor("SYS");
    const birch = await login(sim, "birch@example.test", "Birch Rowan");
    birch.send({ cmd: "JCH", payload: { channel: "ADH-sim0001" } });
    await birch.waitFor("CDS");
    await amber.waitFor("JCH"); // Birch's join echo
    return { sim, amber, birch, channel: "ADH-sim0001" };
  }

  it("kicks: broadcast to everyone including the target, member removed", async () => {
    const { amber, birch, channel } = await roomWithTwo();
    amber.send({
      cmd: "CKU",
      payload: { channel, character: "Birch Rowan" },
    });
    const expected = {
      cmd: "CKU",
      payload: { operator: "Amber Vale", channel, character: "Birch Rowan" },
    };
    expect(parseServerCommand(await birch.waitFor("CKU"))).toEqual(expected);
    expect(parseServerCommand(await amber.waitFor("CKU"))).toEqual(expected);
    // Kicked ≠ banned: rejoining works (still on the invite list).
    birch.send({ cmd: "JCH", payload: { channel } });
    expect(parseServerCommand(await birch.waitFor("JCH"))).toMatchObject({
      payload: { channel },
    });
  });

  it("bans gate JCH with ERR 48 until CUB; CBL lists them via SYS", async () => {
    const { amber, birch, channel } = await roomWithTwo();
    amber.send({
      cmd: "CBU",
      payload: { channel, character: "Birch Rowan" },
    });
    await birch.waitFor("CBU");
    birch.send({ cmd: "JCH", payload: { channel } });
    expect(parseServerCommand(await birch.waitFor("ERR"))).toMatchObject({
      payload: { number: 48 },
    });
    // Double ban → ERR 41; banlist arrives as a channel SYS.
    amber.send({
      cmd: "CBU",
      payload: { channel, character: "Birch Rowan" },
    });
    expect(parseServerCommand(await amber.waitFor("ERR"))).toMatchObject({
      payload: { number: 41 },
    });
    amber.send({ cmd: "CBL", payload: { channel } });
    expect(parseServerCommand(await amber.waitFor("SYS"))).toEqual({
      cmd: "SYS",
      payload: {
        message: "Channel bans for Mod Attic: Birch Rowan.",
        channel,
      },
    });
    // Unban → rejoin works (ERR 42 on a second unban).
    amber.send({
      cmd: "CUB",
      payload: { channel, character: "Birch Rowan" },
    });
    await amber.waitFor("SYS");
    amber.send({
      cmd: "CUB",
      payload: { channel, character: "Birch Rowan" },
    });
    expect(parseServerCommand(await amber.waitFor("ERR"))).toMatchObject({
      payload: { number: 42 },
    });
    birch.send({ cmd: "JCH", payload: { channel } });
    expect(parseServerCommand(await birch.waitFor("JCH"))).toMatchObject({
      payload: { channel },
    });
  });

  it("timeouts block rejoining like a ban while active", async () => {
    const { amber, birch, channel } = await roomWithTwo();
    amber.send({
      cmd: "CTU",
      payload: { channel, character: "Birch Rowan", length: 30 },
    });
    expect(parseServerCommand(await birch.waitFor("CTU"))).toEqual({
      cmd: "CTU",
      payload: {
        operator: "Amber Vale",
        channel,
        length: 30,
        character: "Birch Rowan",
      },
    });
    birch.send({ cmd: "JCH", payload: { channel } });
    expect(parseServerCommand(await birch.waitFor("ERR"))).toMatchObject({
      payload: { number: 48 },
    });
  });

  it("promote/demote broadcast COA/COR and ops are shielded from non-owner kicks", async () => {
    const { amber, birch, channel } = await roomWithTwo();
    amber.send({
      cmd: "COA",
      payload: { channel, character: "Birch Rowan" },
    });
    expect(parseServerCommand(await birch.waitFor("COA"))).toEqual({
      cmd: "COA",
      payload: { character: "Birch Rowan", channel },
    });
    // Birch (op, not owner) cannot kick Amber (the owner) — ERR 21.
    birch.send({ cmd: "CKU", payload: { channel, character: "Amber Vale" } });
    expect(parseServerCommand(await birch.waitFor("ERR"))).toMatchObject({
      payload: { number: 21 },
    });
    // The owner slot is not demotable — CSO moves ownership.
    birch.send({ cmd: "COR", payload: { channel, character: "Amber Vale" } });
    expect(parseServerCommand(await birch.waitFor("ERR"))).toMatchObject({
      payload: { number: 21 },
    });
    amber.send({ cmd: "COR", payload: { channel, character: "Birch Rowan" } });
    expect(parseServerCommand(await birch.waitFor("COR"))).toEqual({
      cmd: "COR",
      payload: { character: "Birch Rowan", channel },
    });
  });

  it("CSO hands ownership over (owner only) and CDS is op-gated", async () => {
    const { amber, birch, channel } = await roomWithTwo();
    // A plain member can neither set the owner nor the description.
    birch.send({ cmd: "CSO", payload: { channel, character: "Birch Rowan" } });
    expect(parseServerCommand(await birch.waitFor("ERR"))).toMatchObject({
      payload: { number: 19 },
    });
    birch.send({
      cmd: "CDS",
      payload: { channel, description: "hijacked" },
    });
    expect(parseServerCommand(await birch.waitFor("ERR"))).toMatchObject({
      payload: { number: 19 },
    });
    amber.send({ cmd: "CSO", payload: { channel, character: "Birch Rowan" } });
    expect(parseServerCommand(await birch.waitFor("CSO"))).toEqual({
      cmd: "CSO",
      payload: { character: "Birch Rowan", channel },
    });
    // The new owner can change the description; it broadcasts as CDS.
    birch.send({
      cmd: "CDS",
      payload: { channel, description: "Under new management." },
    });
    expect(parseServerCommand(await amber.waitFor("CDS"))).toEqual({
      cmd: "CDS",
      payload: { channel, description: "Under new management." },
    });
  });

  it("chatops moderate any channel and appear in the login ADL", async () => {
    const sim = await startSim({
      world: {
        ...(await import("./world.js")).DEFAULT_WORLD,
        chatops: ["Bramble Thorn"],
      },
    });
    const bramble = await login(sim, "thorn@example.test", "Bramble Thorn");
    const amber = await login(sim, "amber@example.test", "Amber Vale");
    for (const client of [bramble, amber]) {
      client.send({ cmd: "JCH", payload: { channel: "Frontpage" } });
      await client.waitFor("CDS");
    }
    // Bramble is no channel op in Frontpage, but chatops may still kick.
    bramble.send({
      cmd: "CKU",
      payload: { channel: "Frontpage", character: "Amber Vale" },
    });
    expect(parseServerCommand(await amber.waitFor("CKU"))).toEqual({
      cmd: "CKU",
      payload: {
        operator: "Bramble Thorn",
        channel: "Frontpage",
        character: "Amber Vale",
      },
    });
  });
});

describe("social JSON API + FRL (M6 step 7)", () => {
  async function socialCall(
    sim: FchatSim,
    path: string,
    form: Record<string, string>,
  ): Promise<Record<string, unknown>> {
    const response = await fetch(new URL(path, sim.httpUrl), {
      method: "POST",
      body: new URLSearchParams(form),
    });
    return (await response.json()) as Record<string, unknown>;
  }

  async function ticketFor(sim: FchatSim, account: string): Promise<string> {
    return sim.issueTicketFor(account);
  }

  it("sends the seeded friends+bookmarks union as FRL at login", async () => {
    const sim = await startSim();
    const client = await TestClient.connect(sim);
    client.send(
      idn(
        "fern@example.test",
        sim.issueTicketFor("fern@example.test"),
        "Fern Glade",
      ),
    );
    expect(parseServerCommand(await client.waitFor("FRL"))).toEqual({
      cmd: "FRL",
      payload: { characters: ["Nyx Firemane", "Old Greywhisker"] },
    });
  });

  it("rejects a stale ticket and serves the seeded lists with a fresh one", async () => {
    const sim = await startSim();
    const account = "fern@example.test";
    const stale = await ticketFor(sim, account);
    const fresh = await ticketFor(sim, account); // invalidates `stale`
    expect(
      await socialCall(sim, "/json/api/bookmark-list.php", {
        account,
        ticket: stale,
      }),
    ).toEqual({ error: "Invalid ticket." });
    expect(
      await socialCall(sim, "/json/api/bookmark-list.php", {
        account,
        ticket: fresh,
      }),
    ).toEqual({ error: "", characters: ["Old Greywhisker"] });
    expect(
      await socialCall(sim, "/json/api/friend-list.php", {
        account,
        ticket: fresh,
      }),
    ).toEqual({
      error: "",
      friends: [{ source: "Nyx Firemane", dest: "Fern Glade" }],
    });
  });

  it("adds and removes bookmarks with envelope errors on misuse", async () => {
    const sim = await startSim();
    const account = "amber@example.test";
    const ticket = await ticketFor(sim, account);
    const call = (path: string, extra: Record<string, string>) =>
      socialCall(sim, path, { account, ticket, ...extra });
    expect(
      await call("/json/api/bookmark-add.php", { name: "Tally Marsh" }),
    ).toEqual({ error: "" });
    expect(
      await call("/json/api/bookmark-add.php", { name: "Tally Marsh" }),
    ).toEqual({ error: "You already have this character bookmarked." });
    expect(
      await call("/json/api/bookmark-list.php", {}),
    ).toEqual({ error: "", characters: ["Tally Marsh"] });
    expect(
      await call("/json/api/bookmark-remove.php", { name: "Tally Marsh" }),
    ).toEqual({ error: "" });
    expect(
      await call("/json/api/bookmark-remove.php", { name: "Tally Marsh" }),
    ).toEqual({ error: "You do not have this character bookmarked." });
  });

  it("walks a friend request end to end: send → pending/incoming → accept → symmetric friendship → remove", async () => {
    const sim = await startSim();
    const amber = "amber@example.test";
    const birch = "birch@example.test";
    const amberTicket = await ticketFor(sim, amber);
    const birchTicket = await ticketFor(sim, birch);

    // Amber Vale sends Birch Rowan a request.
    expect(
      await socialCall(sim, "/json/api/request-send.php", {
        account: amber,
        ticket: amberTicket,
        source_name: "Amber Vale",
        dest_name: "Birch Rowan",
      }),
    ).toEqual({ error: "" });
    // Duplicate refused.
    expect(
      (
        await socialCall(sim, "/json/api/request-send.php", {
          account: amber,
          ticket: amberTicket,
          source_name: "Amber Vale",
          dest_name: "Birch Rowan",
        })
      )["error"],
    ).toContain("already a pending request");

    const pending = await socialCall(sim, "/json/api/request-pending.php", {
      account: amber,
      ticket: amberTicket,
    });
    const incoming = await socialCall(sim, "/json/api/request-list.php", {
      account: birch,
      ticket: birchTicket,
    });
    expect(pending["requests"]).toEqual(incoming["requests"]);
    const request = (
      incoming["requests"] as { id: number; source: string; dest: string }[]
    )[0]!;
    expect(request).toMatchObject({
      source: "Amber Vale",
      dest: "Birch Rowan",
    });

    // Birch accepts: friendship lands on BOTH accounts.
    expect(
      await socialCall(sim, "/json/api/request-accept.php", {
        account: birch,
        ticket: birchTicket,
        request_id: String(request.id),
      }),
    ).toEqual({ error: "" });
    expect(
      (
        await socialCall(sim, "/json/api/friend-list.php", {
          account: birch,
          ticket: birchTicket,
        })
      )["friends"],
    ).toEqual([{ source: "Amber Vale", dest: "Birch Rowan" }]);
    expect(
      (
        await socialCall(sim, "/json/api/friend-list.php", {
          account: amber,
          ticket: amberTicket,
        })
      )["friends"],
    ).toEqual([{ source: "Birch Rowan", dest: "Amber Vale" }]);

    // Removing is symmetric too.
    expect(
      await socialCall(sim, "/json/api/friend-remove.php", {
        account: amber,
        ticket: amberTicket,
        source_name: "Amber Vale",
        dest_name: "Birch Rowan",
      }),
    ).toEqual({ error: "" });
    expect(
      (
        await socialCall(sim, "/json/api/friend-list.php", {
          account: birch,
          ticket: birchTicket,
        })
      )["friends"],
    ).toEqual([]);
  });

  it("denies and cancels requests", async () => {
    const sim = await startSim();
    const fern = "fern@example.test";
    const ticket = await ticketFor(sim, fern);
    // The seeded incoming request from Tally Marsh can be denied.
    const incoming = await socialCall(sim, "/json/api/request-list.php", {
      account: fern,
      ticket,
    });
    const seeded = (incoming["requests"] as { id: number }[])[0]!;
    expect(
      await socialCall(sim, "/json/api/request-deny.php", {
        account: fern,
        ticket,
        request_id: String(seeded.id),
      }),
    ).toEqual({ error: "" });
    // Fern sends one and cancels it.
    await socialCall(sim, "/json/api/request-send.php", {
      account: fern,
      ticket,
      source_name: "Fern Glade",
      dest_name: "Amber Vale",
    });
    const outgoing = await socialCall(sim, "/json/api/request-pending.php", {
      account: fern,
      ticket,
    });
    const sent = (outgoing["requests"] as { id: number }[])[0]!;
    expect(
      await socialCall(sim, "/json/api/request-cancel.php", {
        account: fern,
        ticket,
        request_id: String(sent.id),
      }),
    ).toEqual({ error: "" });
    expect(
      (
        await socialCall(sim, "/json/api/request-pending.php", {
          account: fern,
          ticket,
        })
      )["requests"],
    ).toEqual([]);
  });
});
