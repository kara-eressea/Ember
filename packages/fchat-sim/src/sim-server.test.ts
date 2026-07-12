import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import {
  apiTicketResponseSchema,
  parseServerCommand,
  serializeClientCommand,
  type ClientCommand,
} from "@emberline/fchat-protocol";
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
      cname: "Emberline",
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
  it("walks IDN → HLO → VAR → CON → LIS → NLN in order", async () => {
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
    await client.waitFor("CON");
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
        ],
      },
    });
    client.send({ cmd: "ORS" });
    const ors = parseServerCommand(await client.waitFor("ORS"));
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
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(amber.pendingCount()).toBe(0);
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
    const sim = await startSim({ pingIntervalMs: 30 });
    const client = await login(sim, "amber@example.test", "Amber Vale");
    for (let i = 0; i < 6; i += 1) {
      await client.waitFor("PIN");
      client.send({ cmd: "PIN" });
    }
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
