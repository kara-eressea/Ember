// Seen-members store (#200) against real Postgres: part upserts, rejoin
// deletes, FLN as a global part, cap eviction, retention (sweep + read-time
// filter), and the snapshot serve path. The session is a stub carrying a
// real SessionState + bus, applied-then-emitted exactly like FchatSession.

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { eq } from "drizzle-orm";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ServerCommand } from "@emberchat/fchat-protocol";
import { createDb, type Db } from "../../db/index.js";
import {
  appUsers,
  conversations,
  flistAccounts,
  identities,
  seenMembers,
} from "../../db/schema.js";
import { buildSnapshot } from "../gateway/snapshot.js";
import { SessionEventBus } from "../session-engine/event-bus.js";
import type { FchatSession } from "../session-engine/fchat-session.js";
import { SessionState } from "../session-engine/session-state.js";
import { SeenMembersStore, seenByChannel } from "./store.js";

const MIGRATIONS = fileURLToPath(new URL("../../../drizzle", import.meta.url));
const KEY = "Frontpage";
const DAY_MS = 86_400_000;

let container: StartedPostgreSqlContainer;
let db: Db;
let pool: { end: () => Promise<void> };
let identityId: string;

/** FchatSession's shape as the store sees it: state folded before emit. */
class StubSession {
  readonly events = new SessionEventBus();
  readonly state = new SessionState();

  push(command: ServerCommand): void {
    this.state.apply(command);
    this.events.emit("command", command);
  }

  disconnect(): void {
    this.state.resetVolatile();
    this.events.emit("status", { status: "backoff" });
  }
}

function jch(channel: string, character: string): ServerCommand {
  return {
    cmd: "JCH",
    payload: { channel, character: { identity: character }, title: channel },
  };
}

function ich(channel: string, names: string[]): ServerCommand {
  return {
    cmd: "ICH",
    payload: {
      channel,
      mode: "chat",
      users: names.map((identity) => ({ identity })),
    },
  };
}

function lch(channel: string, character: string): ServerCommand {
  return { cmd: "LCH", payload: { channel, character } };
}

/** A session already identified as Amber, with the default roster joined.
 * The store attaches first (as in onSessionStarted) so it sees every
 * command, ICH included — the mirror only tracks channels it observed. */
function onlineSession(store?: SeenMembersStore): StubSession {
  const session = new StubSession();
  store?.attach(identityId, session);
  session.push({
    cmd: "IDN",
    payload: { character: "Amber Vale" },
  });
  session.push({
    cmd: "LIS",
    payload: {
      characters: [
        ["Amber Vale", "Female", "online", ""],
        ["Nyx Firemane", "Female", "online", ""],
        ["Tally Marsh", "Male", "looking", ""],
      ],
    },
  });
  session.push(jch(KEY, "Amber Vale"));
  session.push(ich(KEY, ["Amber Vale", "Nyx Firemane", "Tally Marsh"]));
  return session;
}

async function seenRows() {
  return db
    .select()
    .from(seenMembers)
    .where(eq(seenMembers.identityId, identityId));
}

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:18-alpine").start();
  ({ db, pool } = createDb(container.getConnectionUri()));
  await migrate(db, { migrationsFolder: MIGRATIONS });
  const [user] = await db
    .insert(appUsers)
    .values({
      email: "seen@example.test",
      username: "seen",
      passwordHash: "x",
    })
    .returning();
  const [account] = await db
    .insert(flistAccounts)
    .values({ userId: user!.id, accountName: "seen@example.test" })
    .returning();
  const [identity] = await db
    .insert(identities)
    .values({ flistAccountId: account!.id, characterName: "Amber Vale" })
    .returning();
  identityId = identity!.id;
}, 120_000);

afterAll(async () => {
  await pool.end();
  await container.stop();
});

beforeEach(async () => {
  await db.delete(seenMembers);
  await db.delete(conversations);
});

describe("SeenMembersStore", () => {
  it("upserts a departing member with their cached gender", async () => {
    const store = new SeenMembersStore({ db });
    const session = onlineSession(store);
    session.push(lch(KEY, "Nyx Firemane"));
    await store.idle();
    const rows = await seenRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      channelKey: KEY,
      character: "Nyx Firemane",
      characterLower: "nyx firemane",
      gender: "Female",
    });
  });

  it("deletes the row again on rejoin — never present and seen at once", async () => {
    const store = new SeenMembersStore({ db });
    const session = onlineSession(store);
    session.push(lch(KEY, "Nyx Firemane"));
    session.push(jch(KEY, "Nyx Firemane"));
    await store.idle();
    expect(await seenRows()).toHaveLength(0);
  });

  it("clears present members' rows on a full roster (ICH) overwrite", async () => {
    const store = new SeenMembersStore({ db });
    const session = onlineSession(store);
    // A row left over from a previous run whose part we never saw.
    await db.insert(seenMembers).values({
      identityId,
      channelKey: KEY,
      characterLower: "old greywhisker",
      character: "Old Greywhisker",
      gender: "None",
    });
    session.push(ich(KEY, ["Amber Vale", "Old Greywhisker"]));
    await store.idle();
    expect(await seenRows()).toHaveLength(0);
  });

  it("treats FLN as a part in every observed channel", async () => {
    const store = new SeenMembersStore({ db });
    const session = onlineSession(store);
    session.push(jch("Development", "Amber Vale"));
    session.push(ich("Development", ["Amber Vale", "Tally Marsh"]));
    session.push({
      cmd: "FLN",
      payload: { character: "Tally Marsh" },
    });
    await store.idle();
    const rows = await seenRows();
    expect(rows.map((row) => row.channelKey).sort()).toEqual([
      "Development",
      KEY,
    ]);
    expect(rows.every((row) => row.character === "Tally Marsh")).toBe(true);
  });

  it("records nothing for our own leave, and stops watching the channel", async () => {
    const store = new SeenMembersStore({ db });
    const session = onlineSession(store);
    session.push(lch(KEY, "Amber Vale"));
    // A stale LCH for the abandoned channel must be inert.
    session.push(lch(KEY, "Nyx Firemane"));
    await store.idle();
    expect(await seenRows()).toHaveLength(0);
  });

  it("never stamps lastSeen on our own disconnect", async () => {
    const store = new SeenMembersStore({ db });
    const session = onlineSession(store);
    session.disconnect();
    await store.idle();
    expect(await seenRows()).toHaveLength(0);
  });

  it("silently evicts the oldest-seen rows past the cap", async () => {
    let tick = 0;
    const store = new SeenMembersStore({
      db,
      capPerChannel: 2,
      now: () => new Date(1_700_000_000_000 + ++tick * 1000),
    });
    const session = onlineSession(store);
    session.push(ich(KEY, ["Amber Vale", "One", "Two", "Three"]));
    session.push(lch(KEY, "One"));
    session.push(lch(KEY, "Two"));
    session.push(lch(KEY, "Three"));
    await store.idle();
    const rows = await seenRows();
    expect(rows.map((row) => row.character).sort()).toEqual(["Three", "Two"]);
  });

  it("ages rows out on sweep", async () => {
    const store = new SeenMembersStore({ db });
    await db.insert(seenMembers).values([
      {
        identityId,
        channelKey: KEY,
        characterLower: "ancient",
        character: "Ancient",
        gender: "",
        lastSeenAt: new Date(Date.now() - 8 * DAY_MS),
      },
      {
        identityId,
        channelKey: KEY,
        characterLower: "recent",
        character: "Recent",
        gender: "",
        lastSeenAt: new Date(),
      },
    ]);
    await expect(store.sweepOnce()).resolves.toEqual({ deleted: 1 });
    const rows = await seenRows();
    expect(rows.map((row) => row.character)).toEqual(["Recent"]);
  });
});

describe("serve path", () => {
  it("groups per channel, newest first, filtering expired rows at read time", async () => {
    const now = Date.now();
    await db.insert(seenMembers).values([
      {
        identityId,
        channelKey: KEY,
        characterLower: "older",
        character: "Older",
        gender: "Male",
        lastSeenAt: new Date(now - 2 * DAY_MS),
      },
      {
        identityId,
        channelKey: KEY,
        characterLower: "newer",
        character: "Newer",
        gender: "Female",
        lastSeenAt: new Date(now - DAY_MS),
      },
      {
        identityId,
        channelKey: KEY,
        characterLower: "expired",
        character: "Expired",
        gender: "",
        // Past retention but not yet swept — must not be served.
        lastSeenAt: new Date(now - 8 * DAY_MS),
      },
    ]);
    const byChannel = await seenByChannel(db, identityId);
    expect(byChannel.get(KEY)?.map((entry) => entry.character)).toEqual([
      "Newer",
      "Older",
    ]);
  });

  it("serves seen in the snapshot minus anyone currently present", async () => {
    await db.insert(conversations).values({
      identityId,
      kind: "channel",
      channelKey: KEY,
      title: KEY,
      joined: true,
    });
    await db.insert(seenMembers).values([
      {
        identityId,
        channelKey: KEY,
        characterLower: "vesna kohl",
        character: "Vesna Kohl",
        gender: "Female",
      },
      {
        // Rejoined, but the delete is still queued — the serve filters it.
        identityId,
        channelKey: KEY,
        characterLower: "nyx firemane",
        character: "Nyx Firemane",
        gender: "Female",
      },
    ]);
    // No store attached: this exercises the serve-time filter alone.
    const session = onlineSession();
    const snapshot = await buildSnapshot(
      db,
      identityId,
      session as unknown as FchatSession,
    );
    const channel = snapshot.channels.find((ch) => ch.key === KEY);
    expect(channel?.seen.map((entry) => entry.character)).toEqual([
      "Vesna Kohl",
    ]);
    expect(typeof channel?.seen[0]?.lastSeen).toBe("number");
  });

  it("serves seen even without a live session (server-held history)", async () => {
    await db.insert(conversations).values({
      identityId,
      kind: "channel",
      channelKey: KEY,
      title: KEY,
      joined: true,
    });
    await db.insert(seenMembers).values({
      identityId,
      channelKey: KEY,
      characterLower: "vesna kohl",
      character: "Vesna Kohl",
      gender: "Female",
    });
    const snapshot = await buildSnapshot(db, identityId, undefined);
    const channel = snapshot.channels.find((ch) => ch.key === KEY);
    expect(channel?.seen.map((entry) => entry.character)).toEqual([
      "Vesna Kohl",
    ]);
  });
});
