// Profile routes against real Postgres + fchat-sim: fetch-through-cache,
// budget wiring (stale-with-flag / 429), history, notes, insights over
// seeded messages, guestbook gating, memo import, locked-vault 409.

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { eq, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { FchatSim } from "@emberchat/fchat-sim";
import type { ProfileInsights, ProfileResponse } from "@emberchat/protocol";
import { buildApp } from "../../app.js";
import { loadConfig } from "../../config.js";
import { createDb, type Db } from "../../db/index.js";
import {
  characterCache,
  conversations,
  flistAccounts,
  identities,
  messages,
} from "../../db/schema.js";
import { FlistApiClient } from "../flist-api/api-client.js";
import { CharacterDataBudget } from "./../flist-api/character-data-budget.js";

const MIGRATIONS = fileURLToPath(new URL("../../../drizzle", import.meta.url));
const ACCOUNT = "birch@example.test";
const CHARACTER = "Birch Rowan";

vi.setConfig({ testTimeout: 20_000 });

let container: StartedPostgreSqlContainer;
let db: Db;
let pool: { end: () => Promise<void> };
let sim: FchatSim;
let app: FastifyInstance;
let budget: CharacterDataBudget;
let token: string;
let identityId: string;

beforeAll(async () => {
  sim = new FchatSim();
  await sim.start();
  sim.setCharacterProfile("Nyx Firemane", {
    description: "[b]Nyx[/b], keeper of the Frontpage.",
    kinks: { "620": "fave", "8": "no" },
    // Orientation (id 2) is list-type: canned listitem 9 = "Straight".
    infotags: { "1": "116", "2": "9", "9": "Elf" },
    images: [{ id: 31, extension: "png", height: 640, width: 480 }],
  });
  container = await new PostgreSqlContainer("postgres:18-alpine").start();
  ({ db, pool } = createDb(container.getConnectionUri()));
  await migrate(db, { migrationsFolder: MIGRATIONS });
  budget = new CharacterDataBudget({ limit: 1000 });
  app = await buildApp({
    config: loadConfig({
      DATABASE_URL: container.getConnectionUri(),
      AUTH_SECRET: "integration-test-secret-0123456789abcdef",
      AUTH_RATE_LIMIT_MAX: "1000",
      RATE_LIMIT_MAX: "10000",
      REGISTRATION_ENABLED: "true",
      FCHAT_URL: sim.wsUrl,
      FLIST_API_URL: sim.httpUrl,
    }),
    db,
    logger: false,
    flistApiClient: new FlistApiClient({
      baseUrl: sim.httpUrl,
      minRequestIntervalMs: 0,
    }),
    characterDataBudget: budget,
  });

  const registered = await app.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: {
      email: "profiles@example.test",
      username: "profiles",
      password: "hunter2hunter2",
    },
  });
  expect(registered.statusCode).toBe(201);
  token = registered.json<{ accessToken: string }>().accessToken;
  const added = await app.inject({
    method: "POST",
    url: "/api/flist-accounts",
    headers: { authorization: `Bearer ${token}` },
    payload: { accountName: ACCOUNT, password: "hunter2" },
  });
  expect(added.statusCode).toBe(201);
  const accountId = added.json<{ account: { id: string } }>().account.id;
  const [identity] = await db
    .insert(identities)
    .values({ flistAccountId: accountId, characterName: CHARACTER })
    .returning({ id: identities.id });
  identityId = identity!.id;
}, 180_000);

afterAll(async () => {
  await app.close();
  await pool.end();
  await container.stop();
  await sim.stop();
});

function get(url: string) {
  return app.inject({
    method: "GET",
    url,
    headers: { authorization: `Bearer ${token}` },
  });
}

function request(method: "PUT" | "DELETE", url: string, payload?: object) {
  return app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${token}` },
    payload,
  });
}

const base = () => `/api/identities/${identityId}`;

describe("profile fetch-through-cache", () => {
  it("cache miss: fetches, resolves mappings, records history", async () => {
    const before = budget.used;
    const response = await get(`${base()}/profile/nyx firemane`);
    expect(response.statusCode).toBe(200);
    const body = response.json<ProfileResponse>();
    expect(budget.used).toBe(before + 1);
    expect(body.profile.name).toBe("Nyx Firemane");
    expect(body.stale).toBe(false);
    expect(body.budgetExhausted).toBe(false);
    expect(body.note).toBeNull();
    // List-type infotags resolve through listitems; text tags pass through.
    const tags = body.profile.infotagGroups.flatMap((group) => group.tags);
    expect(tags).toContainEqual({
      id: 2,
      label: "Orientation",
      value: "Straight",
    });
    expect(tags).toContainEqual({ id: 9, label: "Species", value: "Elf" });
    // Kinks resolve to names; unknown/none choices are dropped.
    expect(body.profile.kinks).toContainEqual({
      id: 620,
      name: "Age Differences",
      description: "Adult characters with significant age gaps.",
      choice: "fave",
    });
    // Image URL assembled from the string-typed payload.
    expect(body.profile.images[0]).toMatchObject({
      id: 31,
      url: "https://static.f-list.net/images/charimage/31.png",
      width: 480,
      height: 640,
    });
    expect(body.profile.settings.guestbook).toBe(false);

    const history = await get(`${base()}/profile-history`);
    expect(
      history
        .json<{ history: { name: string; viewCount: number }[] }>()
        .history.find((row) => row.name === "Nyx Firemane")?.viewCount,
    ).toBe(1);
  });

  it("cache hit: serves without spending budget, bumps the view count", async () => {
    const before = budget.used;
    const response = await get(`${base()}/profile/Nyx Firemane`);
    expect(response.statusCode).toBe(200);
    expect(budget.used).toBe(before);
    const history = await get(`${base()}/profile-history`);
    expect(
      history
        .json<{ history: { name: string; viewCount: number }[] }>()
        .history.find((row) => row.name === "Nyx Firemane")?.viewCount,
    ).toBe(2);
  });

  it("refresh=1 bypasses the TTL but spends budget", async () => {
    const before = budget.used;
    const response = await get(`${base()}/profile/Nyx Firemane?refresh=1`);
    expect(response.statusCode).toBe(200);
    expect(budget.used).toBe(before + 1);
  });

  it("an aged cache row refetches on the next view", async () => {
    const before = budget.used;
    await db
      .update(characterCache)
      .set({ fetchedAt: sql`now() - interval '25 hours'` })
      .where(eq(characterCache.characterLower, "nyx firemane"));
    const response = await get(`${base()}/profile/Nyx Firemane`);
    expect(response.statusCode).toBe(200);
    expect(budget.used).toBe(before + 1);
    expect(response.json<ProfileResponse>().stale).toBe(false);
  });

  it("unknown character → 404 with the upstream reason", async () => {
    const response = await get(`${base()}/profile/Nobody Realsson`);
    expect(response.statusCode).toBe(404);
    expect(response.json<{ error: string }>().error).toBe(
      "Character not found.",
    );
  });
});

describe("history", () => {
  it("lists newest-first and deletes single entries", async () => {
    await get(`${base()}/profile/Old Greywhisker`);
    const listed = await get(`${base()}/profile-history`);
    const names = listed
      .json<{ history: { name: string }[] }>()
      .history.map((row) => row.name);
    expect(names[0]).toBe("Old Greywhisker");
    expect(names).toContain("Nyx Firemane");

    const deleted = await request(
      "DELETE",
      `${base()}/profile-history/old greywhisker`,
    );
    expect(deleted.statusCode).toBe(200);
    const after = await get(`${base()}/profile-history`);
    expect(
      after.json<{ history: { name: string }[] }>().history,
    ).not.toContainEqual(expect.objectContaining({ name: "Old Greywhisker" }));
    expect(
      (await request("DELETE", `${base()}/profile-history/old greywhisker`))
        .statusCode,
    ).toBe(404);
  });
});

describe("notes", () => {
  it("round-trips, survives history pruning, rides in the profile response", async () => {
    expect(
      (
        await request("PUT", `${base()}/profile/Nyx Firemane/note`, {
          note: "keeper of the Frontpage — we spoke about lanterns",
        })
      ).statusCode,
    ).toBe(200);
    const note = await get(`${base()}/profile/Nyx Firemane/note`);
    expect(note.json<{ note: string | null }>().note).toContain("lanterns");

    // Prune the history row; the note must survive (separate table).
    await request("DELETE", `${base()}/profile-history/Nyx Firemane`);
    expect(
      (await get(`${base()}/profile/Nyx Firemane/note`)).json<{
        note: string | null;
      }>().note,
    ).toContain("lanterns");

    // The note rides along in the profile response.
    const profile = await get(`${base()}/profile/Nyx Firemane`);
    expect(profile.json<ProfileResponse>().note).toContain("lanterns");

    // Empty note = delete.
    await request("PUT", `${base()}/profile/Nyx Firemane/note`, { note: "" });
    expect(
      (await get(`${base()}/profile/Nyx Firemane/note`)).json<{
        note: string | null;
      }>().note,
    ).toBeNull();
  });
});

describe("insights", () => {
  it("aggregates seeded messages scoped to the requesting identity", async () => {
    const [dm] = await db
      .insert(conversations)
      .values({
        identityId,
        kind: "pm",
        partnerCharacter: "Tally Marsh",
        title: "Tally Marsh",
      })
      .returning({ id: conversations.id });
    const [channel] = await db
      .insert(conversations)
      .values({
        identityId,
        kind: "channel",
        channelKey: "Frontpage",
        title: "Frontpage",
      })
      .returning({ id: conversations.id });
    await db.insert(messages).values([
      {
        conversationId: channel!.id,
        senderCharacter: "Tally Marsh",
        kind: "msg",
        bbcode: "hello from the channel",
        createdAt: new Date("2026-07-01T10:00:00Z"),
      },
      {
        conversationId: dm!.id,
        senderCharacter: CHARACTER,
        kind: "pm",
        bbcode: "hi tally",
        sentByUs: true,
        createdAt: new Date("2026-07-02T10:00:00Z"),
      },
      {
        conversationId: dm!.id,
        senderCharacter: "Tally Marsh",
        kind: "pm",
        bbcode: "hi birch",
        createdAt: new Date("2026-07-03T10:00:00Z"),
      },
    ]);

    const response = await get(`${base()}/profile/tally marsh/insights`);
    expect(response.statusCode).toBe(200);
    const insights = response.json<ProfileInsights>();
    expect(insights.messagesSent).toBe(1);
    expect(insights.messagesReceived).toBe(1);
    expect(insights.lastChattedAt).toBe(
      new Date("2026-07-03T10:00:00Z").getTime(),
    );
    expect(insights.firstEncountered).toEqual({
      at: new Date("2026-07-01T10:00:00Z").getTime(),
      conversation: "Frontpage",
    });
    expect(insights.lastSeenTalkingAt).toBe(
      new Date("2026-07-03T10:00:00Z").getTime(),
    );
    // Detached identity: live fields are honestly empty.
    expect(insights.online).toBe(false);
    expect(insights.sharedChannels).toEqual([]);
  });

  it("never-crossed-paths returns the empty shape", async () => {
    const response = await get(`${base()}/profile/Willow Reed/insights`);
    expect(response.statusCode).toBe(200);
    expect(response.json<ProfileInsights>()).toMatchObject({
      messagesSent: 0,
      messagesReceived: 0,
      lastChattedAt: null,
      firstEncountered: null,
      lastSeenTalkingAt: null,
      online: false,
      sharedChannels: [],
      timesViewed: 0,
      firstViewedAt: null,
    });
  });
});

describe("guestbook + memo", () => {
  it("serves guestbook pages when enabled, 404 when the profile has none", async () => {
    sim.setGuestbook("Old Greywhisker", [
      {
        from: "Tally Marsh",
        message: "an old friend",
        postedAt: 1_752_000_100,
      },
    ]);
    // The cached copy predates the guestbook — refresh picks up the flag.
    await get(`${base()}/profile/Old Greywhisker?refresh=1`);
    const page = await get(`${base()}/profile/Old Greywhisker/guestbook`);
    expect(page.statusCode).toBe(200);
    expect(
      page.json<{ posts: { character: string; message: string }[] }>().posts,
    ).toEqual([
      expect.objectContaining({
        character: "Tally Marsh",
        message: "an old friend",
      }),
    ]);

    const none = await get(`${base()}/profile/Nyx Firemane/guestbook`);
    expect(none.statusCode).toBe(404);
  });

  it("guestbook pages spend budget; memo reads do not", async () => {
    const before = budget.used;
    await get(`${base()}/profile/Old Greywhisker/guestbook`);
    expect(budget.used).toBe(before + 1);

    sim.setMemo(ACCOUNT, "Nyx Firemane", "remember the lantern trade");
    const memoBefore = budget.used;
    const memo = await get(`${base()}/profile/Nyx Firemane/memo`);
    expect(memo.statusCode).toBe(200);
    expect(memo.json<{ note: string | null }>().note).toBe(
      "remember the lantern trade",
    );
    expect(budget.used).toBe(memoBefore);
  });
});

describe("authorization + vault", () => {
  it("hides other users' identities", async () => {
    const stranger = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: {
        email: "profiles-stranger@example.test",
        username: "profstranger",
        password: "hunter2hunter2",
      },
    });
    const strangerToken = stranger.json<{ accessToken: string }>().accessToken;
    const response = await app.inject({
      method: "GET",
      url: `${base()}/profile/Nyx Firemane`,
      headers: { authorization: `Bearer ${strangerToken}` },
    });
    expect(response.statusCode).toBe(404);
  });

  it("a locked vault (post-restart state) surfaces as 409", async () => {
    // An flist account row without a vault entry = the post-restart state
    // (credentials are memory-only by design).
    const [user] = await db.select().from(flistAccounts).limit(1);
    const [locked] = await db
      .insert(flistAccounts)
      .values({ userId: user!.userId, accountName: "locked@example.test" })
      .returning({ id: flistAccounts.id });
    const [lockedIdentity] = await db
      .insert(identities)
      .values({ flistAccountId: locked!.id, characterName: "Willow Reed" })
      .returning({ id: identities.id });
    const response = await get(
      `/api/identities/${lockedIdentity!.id}/profile/Tally Marsh?refresh=1`,
    );
    expect(response.statusCode).toBe(409);
    expect(response.json<{ error: string }>().error).toContain("locked");
  });
});

// Runs LAST: draining the shared budget is irreversible within the suite
// (the sliding window is an hour long and the instance is shared).
describe("budget exhaustion", () => {
  it("cached → stale-with-flag, uncached → 429 with retryAfterSeconds", async () => {
    while (budget.tryConsume()) {
      // drain
    }
    await db
      .update(characterCache)
      .set({ fetchedAt: sql`now() - interval '25 hours'` })
      .where(eq(characterCache.characterLower, "nyx firemane"));
    const cached = await get(`${base()}/profile/Nyx Firemane`);
    expect(cached.statusCode).toBe(200);
    const body = cached.json<ProfileResponse>();
    expect(body.stale).toBe(true);
    expect(body.budgetExhausted).toBe(true);
    expect(body.profile.name).toBe("Nyx Firemane");

    const uncached = await get(`${base()}/profile/Willow Reed`);
    expect(uncached.statusCode).toBe(429);
    expect(
      uncached.json<{ retryAfterSeconds: number }>().retryAfterSeconds,
    ).toBeGreaterThan(0);

    // A guestbook page is budget-class too: exhausted → 429 (cached
    // profile serves, the page fetch is refused).
    const guestbook = await get(`${base()}/profile/Old Greywhisker/guestbook`);
    expect(guestbook.statusCode).toBe(429);
  });
});
