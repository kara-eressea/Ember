// Social routes against real Postgres + fchat-sim: the production path from
// account-add (vaulted password → per-account TicketManager) through the
// throttle-shared FlistApiClient to the sim's JSON endpoints, with presence
// enrichment from the live session roster.

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { FchatSim } from "@emberchat/fchat-sim";
import { buildApp } from "../../app.js";
import { loadConfig } from "../../config.js";
import { createDb, type Db } from "../../db/index.js";
import { identities } from "../../db/schema.js";
import { FlistApiClient } from "../flist-api/api-client.js";

const MIGRATIONS = fileURLToPath(new URL("../../../drizzle", import.meta.url));
const ACCOUNT = "fern@example.test";
const CHARACTER = "Fern Glade";

vi.setConfig({ testTimeout: 20_000 });

let container: StartedPostgreSqlContainer;
let db: Db;
let pool: { end: () => Promise<void> };
let sim: FchatSim;
let app: FastifyInstance;
let token: string;
let identityId: string;

beforeAll(async () => {
  sim = new FchatSim();
  await sim.start();
  container = await new PostgreSqlContainer("postgres:18-alpine").start();
  ({ db, pool } = createDb(container.getConnectionUri()));
  await migrate(db, { migrationsFolder: MIGRATIONS });
  app = await buildApp({
    config: loadConfig({
      DATABASE_URL: container.getConnectionUri(),
      AUTH_SECRET: "integration-test-secret-0123456789abcdef",
      AUTH_RATE_LIMIT_MAX: "1000",
      FCHAT_URL: sim.wsUrl,
      FLIST_API_URL: sim.httpUrl,
    }),
    db,
    logger: false,
    flistApiClient: new FlistApiClient({
      baseUrl: sim.httpUrl,
      minRequestIntervalMs: 0,
    }),
  });

  const registered = await app.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: {
      email: "social@example.test",
      username: "social",
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

function post(url: string, payload: object) {
  return app.inject({
    method: "POST",
    url,
    headers: { authorization: `Bearer ${token}` },
    payload,
  });
}

interface SocialBody {
  bookmarks: { name: string; online: boolean; status: string }[];
  friends: { name: string; online: boolean; status: string }[];
  incoming: { id: number; name: string }[];
  outgoing: { id: number; name: string }[];
}

describe("social routes", () => {
  it("serves the seeded lists, presence-enriched from the live roster", async () => {
    // Presence enrichment needs a live session (NPCs are "online").
    app.sessions.start({
      identityId,
      character: CHARACTER,
      accountId: (
        await db.select().from(identities).limit(1)
      )[0]!.flistAccountId,
      accountName: ACCOUNT,
    });
    await vi.waitFor(() => {
      expect(app.sessions.get(identityId)?.status).toBe("online");
    });

    const response = await get(`/api/identities/${identityId}/social`);
    expect(response.statusCode).toBe(200);
    const body = response.json<SocialBody>();
    expect(body.bookmarks).toEqual([
      // Old Greywhisker is an online NPC with status busy.
      { name: "Old Greywhisker", online: true, status: "busy", statusmsg: "Lurking." },
    ]);
    expect(body.friends).toEqual([
      { name: "Nyx Firemane", online: true, status: "online", statusmsg: "" },
    ]);
    expect(body.incoming).toEqual([{ id: 1, name: "Tally Marsh" }]);
    expect(body.outgoing).toEqual([]);
  });

  it("adds and removes a bookmark through the API", async () => {
    expect(
      (
        await post(`/api/identities/${identityId}/social/bookmark`, {
          action: "add",
          name: "Tally Marsh",
        })
      ).statusCode,
    ).toBe(200);
    let body = (await get(`/api/identities/${identityId}/social`)).json<SocialBody>();
    expect(body.bookmarks.map((row) => row.name)).toEqual([
      "Old Greywhisker",
      "Tally Marsh",
    ]);
    // Upstream refusals surface as 502 with the F-List error text.
    const duplicate = await post(
      `/api/identities/${identityId}/social/bookmark`,
      { action: "add", name: "Tally Marsh" },
    );
    expect(duplicate.statusCode).toBe(502);
    expect(duplicate.json<{ error: string }>().error).toContain(
      "already have this character bookmarked",
    );
    expect(
      (
        await post(`/api/identities/${identityId}/social/bookmark`, {
          action: "remove",
          name: "Tally Marsh",
        })
      ).statusCode,
    ).toBe(200);
    body = (await get(`/api/identities/${identityId}/social`)).json<SocialBody>();
    expect(body.bookmarks.map((row) => row.name)).toEqual(["Old Greywhisker"]);
  });

  it("accepts the seeded request and walks send → cancel", async () => {
    expect(
      (
        await post(`/api/identities/${identityId}/social/request`, {
          action: "accept",
          requestId: 1,
        })
      ).statusCode,
    ).toBe(200);
    let body = (await get(`/api/identities/${identityId}/social`)).json<SocialBody>();
    expect(body.friends.map((row) => row.name).sort()).toEqual([
      "Nyx Firemane",
      "Tally Marsh",
    ]);
    expect(body.incoming).toEqual([]);

    expect(
      (
        await post(`/api/identities/${identityId}/social/request`, {
          action: "send",
          character: "Amber Vale",
        })
      ).statusCode,
    ).toBe(200);
    body = (await get(`/api/identities/${identityId}/social`)).json<SocialBody>();
    const sent = body.outgoing.find((row) => row.name === "Amber Vale");
    expect(sent).toBeDefined();
    expect(
      (
        await post(`/api/identities/${identityId}/social/request`, {
          action: "cancel",
          requestId: sent!.id,
        })
      ).statusCode,
    ).toBe(200);

    // remove-friend undoes the accept.
    expect(
      (
        await post(`/api/identities/${identityId}/social/request`, {
          action: "remove-friend",
          character: "Tally Marsh",
        })
      ).statusCode,
    ).toBe(200);
    body = (await get(`/api/identities/${identityId}/social`)).json<SocialBody>();
    expect(body.friends.map((row) => row.name)).toEqual(["Nyx Firemane"]);
  });

  it("hides other users' identities", async () => {
    const stranger = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: {
        email: "social-stranger@example.test",
        username: "socialstranger",
        password: "hunter2hunter2",
      },
    });
    const strangerToken = stranger.json<{ accessToken: string }>().accessToken;
    const response = await app.inject({
      method: "GET",
      url: `/api/identities/${identityId}/social`,
      headers: { authorization: `Bearer ${strangerToken}` },
    });
    expect(response.statusCode).toBe(404);
  });
});
