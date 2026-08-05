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
import type {
  ProfileActivity,
  ProfileInsights,
  ProfileResponse,
} from "@emberchat/protocol";
import { buildApp } from "../../app.js";
import { loadConfig } from "../../config.js";
import { createDb, type Db } from "../../db/index.js";
import {
  characterCache,
  characterNotes,
  conversations,
  flistAccounts,
  identities,
  messages,
  profileViews,
} from "../../db/schema.js";
import { FlistApiClient } from "@emberchat/session-engine";
import { CharacterDataBudget } from "./../flist-api/character-data-budget.js";
import {
  CONTAINER_BOOT_MS,
  INTEGRATION_SLOW_MS,
} from "../../test-support/budgets.js";

const MIGRATIONS = fileURLToPath(new URL("../../../drizzle", import.meta.url));
const ACCOUNT = "birch@example.test";
const CHARACTER = "Birch Rowan";

// Above INTEGRATION_MS: each test chains sim JSON fetches through the shared
// throttled FlistApiClient on top of the container round trips.
vi.setConfig({ testTimeout: INTEGRATION_SLOW_MS });

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
    inlines: { "42": { hash: "abcdef0123456789", extension: "png" } },
  });
  // Grouped kinks (#274): a custom kink acts as a folder over standard kinks.
  // 501/502 are grouped under a "fave" custom; 620 is ALSO listed top-level as
  // "no", so precedence (top-level wins) is exercised.
  sim.setCharacterProfile("Fern Ashwood", {
    description: "[b]Fern[/b], folder-keeper.",
    kinks: { "620": "no" },
    customKinks: {
      "1": {
        name: "Quiet evenings",
        description: "Grouped favourites.",
        choice: "fave",
        children: [501, 502, 620],
      },
    },
    infotags: {},
  });
  // The session's own character — used by the self-exclusion test (#209).
  sim.setCharacterProfile(CHARACTER, {
    description: "[b]Birch[/b], the viewer's own character.",
    kinks: { "620": "yes" },
    infotags: {},
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
}, CONTAINER_BOOT_MS);

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
    // Inline images ([img]id[/img]) resolve to the sharded charinline URL.
    expect(body.profile.inlines["42"]).toEqual({
      url: "https://static.f-list.net/images/charinline/ab/cd/abcdef0123456789.png",
    });
    expect(body.profile.settings.guestbook).toBe(false);

    const history = await get(`${base()}/profile-history`);
    expect(
      history
        .json<{ history: { name: string; viewCount: number }[] }>()
        .history.find((row) => row.name === "Nyx Firemane")?.viewCount,
    ).toBe(1);
  });

  it("flattens grouped standard kinks into the matchable list (#274)", async () => {
    const response = await get(`${base()}/profile/Fern Ashwood`);
    expect(response.statusCode).toBe(200);
    const profile = response.json<ProfileResponse>().profile;
    // Grouped standard kinks inherit the parent custom's choice for matching.
    expect(profile.kinks).toContainEqual({
      id: 501,
      name: "Campfire Stories",
      description: "Long tales told in warm light.",
      choice: "fave",
    });
    expect(profile.kinks).toContainEqual({
      id: 502,
      name: "Tea Ceremonies",
      description: "Quiet ritual and good company.",
      choice: "fave",
    });
    // Precedence: an explicit top-level choice wins over the grouped one.
    const ageGap = profile.kinks.filter((kink) => kink.id === 620);
    expect(ageGap).toHaveLength(1);
    expect(ageGap[0]!.choice).toBe("no");
    // The custom kink itself stays display-only, folder intact.
    expect(profile.customKinks).toContainEqual({
      name: "Quiet evenings",
      description: "Grouped favourites.",
      choice: "fave",
      children: [501, 502, 620],
    });
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

  it("does not record the session's own character as a view (#209)", async () => {
    // The Compare/kink-match block fetches the viewer's own profile in the
    // background; that must never surface in recent views.
    const response = await get(`${base()}/profile/${CHARACTER}`);
    expect(response.statusCode).toBe(200);
    expect(response.json<ProfileResponse>().profile.name).toBe(CHARACTER);

    const names = (await get(`${base()}/profile-history`))
      .json<{ history: { name: string }[] }>()
      .history.map((row) => row.name);
    expect(names).not.toContain(CHARACTER);
  });

  it("filters a pre-existing self view out of history at serve time (#209)", async () => {
    // Simulate a row recorded before the fix; it must not be served.
    await db.insert(profileViews).values({
      identityId,
      characterLower: CHARACTER.toLowerCase(),
      characterName: CHARACTER,
      firstViewedAt: new Date(),
      lastViewedAt: new Date(),
    });
    const names = (await get(`${base()}/profile-history`))
      .json<{ history: { name: string }[] }>()
      .history.map((row) => row.name);
    expect(names).not.toContain(CHARACTER);
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

  it("note and timezone clear independently, and the row goes when both do", async () => {
    const noteUrl = `${base()}/profile/Fern Ashwood/note`;
    const tzUrl = `${base()}/profile/Fern Ashwood/timezone`;
    const stored = async () =>
      (await get(noteUrl)).json<{
        note: string | null;
        timezone: string | null;
      }>();
    const rows = async () =>
      (
        await db
          .select()
          .from(characterNotes)
          .where(eq(characterNotes.characterLower, "fern ashwood"))
      ).length;

    // A timezone with no note at all: the row exists for the zone's sake.
    expect(
      (await request("PUT", tzUrl, { timezone: "Asia/Tokyo" })).statusCode,
    ).toBe(200);
    expect(await stored()).toEqual({ note: null, timezone: "Asia/Tokyo" });

    await request("PUT", noteUrl, { note: "met at the lantern market" });
    expect(await stored()).toEqual({
      note: "met at the lantern market",
      timezone: "Asia/Tokyo",
    });
    // Both halves ride the profile response.
    const profile = (
      await get(`${base()}/profile/Fern Ashwood`)
    ).json<ProfileResponse>();
    expect(profile.timezone).toBe("Asia/Tokyo");
    expect(profile.note).toContain("lantern market");

    // Clearing the note keeps the zone…
    await request("PUT", noteUrl, { note: "" });
    expect(await stored()).toEqual({ note: null, timezone: "Asia/Tokyo" });
    expect(await rows()).toBe(1);

    // …and clearing the zone with no note left drops the row entirely.
    await request("PUT", tzUrl, { timezone: null });
    expect(await stored()).toEqual({ note: null, timezone: null });
    expect(await rows()).toBe(0);
  });

  it("refuses a timezone the runtime doesn't know", async () => {
    const refused = await request(
      `PUT`,
      `${base()}/profile/Fern Ashwood/timezone`,
      {
        timezone: "Mars/Olympus_Mons",
      },
    );
    expect(refused.statusCode).toBe(400);
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

describe("activity heatmap", () => {
  // Everything is seeded relative to "now" — the window is a rolling 90 days.
  const DAY = 86_400_000;
  const ago = (days: number, hours = 0) =>
    new Date(Date.now() - days * DAY - hours * 3_600_000);
  /** Grid coordinates a UTC instant lands on, with the DTO's Monday origin. */
  const slot = (at: Date, offsetHours = 0) => {
    const shifted = new Date(at.getTime() + offsetHours * 3_600_000);
    return {
      dow: (shifted.getUTCDay() + 6) % 7,
      hour: shifted.getUTCHours(),
    };
  };

  const inWindow = ago(10, 3);
  const alsoInWindow = ago(3, 7);
  const tooOld = ago(120);

  beforeAll(async () => {
    const [dm] = await db
      .insert(conversations)
      .values({
        identityId,
        kind: "pm",
        partnerCharacter: "Rowan Sage",
        title: "Rowan Sage",
      })
      .returning({ id: conversations.id });
    const [channel] = await db
      .insert(conversations)
      .values({
        identityId,
        kind: "channel",
        channelKey: "Lantern Market",
        title: "Lantern Market",
      })
      .returning({ id: conversations.id });
    await db.insert(messages).values([
      // Counted: a channel line and a DM from them, both inside the window.
      {
        conversationId: channel!.id,
        senderCharacter: "Rowan Sage",
        kind: "msg",
        bbcode: "evening all",
        createdAt: inWindow,
      },
      {
        conversationId: dm!.id,
        senderCharacter: "Rowan Sage",
        kind: "pm",
        bbcode: "hello again",
        createdAt: alsoInWindow,
      },
      // Not counted: an ad (rotation tools post those unattended), our own
      // message, a system line, and anything past the window.
      {
        conversationId: channel!.id,
        senderCharacter: "Rowan Sage",
        kind: "lrp",
        bbcode: "[b]LFRP[/b]",
        createdAt: inWindow,
      },
      {
        conversationId: channel!.id,
        senderCharacter: "Rowan Sage",
        kind: "sys",
        bbcode: "Rowan Sage has joined.",
        createdAt: inWindow,
      },
      {
        conversationId: dm!.id,
        senderCharacter: CHARACTER,
        kind: "pm",
        bbcode: "hi rowan",
        sentByUs: true,
        createdAt: inWindow,
      },
      {
        conversationId: channel!.id,
        senderCharacter: "Rowan Sage",
        kind: "msg",
        bbcode: "ancient history",
        createdAt: tooOld,
      },
    ]);
  });

  it("buckets by weekday and hour in the requested zone", async () => {
    const response = await get(`${base()}/profile/rowan sage/activity?tz=UTC`);
    expect(response.statusCode).toBe(200);
    const activity = response.json<ProfileActivity>();
    expect(activity.windowDays).toBe(90);
    expect(activity.timezone).toBe("UTC");
    expect(activity.grid).toHaveLength(7);
    expect(activity.grid[0]).toHaveLength(24);

    // Ads, system lines, our own messages and pre-window rows are all out.
    expect(activity.total).toBe(2);
    const first = slot(inWindow);
    const second = slot(alsoInWindow);
    expect(activity.grid[first.dow]![first.hour]).toBe(1);
    expect(activity.grid[second.dow]![second.hour]).toBe(1);
  });

  it("re-buckets in another zone rather than shifting labels client-side", async () => {
    const activity = (
      await get(`${base()}/profile/Rowan Sage/activity?tz=Asia/Tokyo`)
    ).json<ProfileActivity>();
    expect(activity.total).toBe(2);
    // Tokyo is a fixed UTC+9 — no DST to complicate the expectation.
    const first = slot(inWindow, 9);
    expect(activity.grid[first.dow]![first.hour]).toBe(1);
  });

  it("is empty, not absent, for someone we've never seen talk", async () => {
    const activity = (
      await get(`${base()}/profile/Willow Reed/activity?tz=UTC`)
    ).json<ProfileActivity>();
    expect(activity.total).toBe(0);
    expect(activity.grid.flat().every((count) => count === 0)).toBe(true);
  });

  it("refuses an unknown zone instead of handing it to Postgres", async () => {
    const refused = await get(
      `${base()}/profile/Rowan Sage/activity?tz=Mars/Olympus_Mons`,
    );
    expect(refused.statusCode).toBe(400);
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
