// Ad-library REST (M10 step 3): full-app integration against real
// Postgres (testcontainers) + fchat-sim (the flist-account add verifies
// against it). Covers ownership scoping, the Horizon-faithful
// normalization, order preservation, and the knownIds compare-and-set.

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { FchatSim } from "@emberchat/fchat-sim";
import type { AdDto } from "@emberchat/protocol";
import { buildApp } from "../../app.js";
import { loadConfig } from "../../config.js";
import { createDb, type Db } from "../../db/index.js";
import { identities } from "../../db/schema.js";
import { FlistApiClient } from "../flist-api/api-client.js";

const MIGRATIONS = fileURLToPath(new URL("../../../drizzle", import.meta.url));
const ACCOUNT = "amber@example.test";
const CHARACTER = "Amber Vale";

vi.setConfig({ testTimeout: 15_000 });

let container: StartedPostgreSqlContainer;
let db: Db;
let pool: { end: () => Promise<void> };
let sim: FchatSim;
let app: FastifyInstance;

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
  });
}, 180_000);

afterAll(async () => {
  await app.close();
  await pool.end();
  await container.stop();
  await sim.stop();
});

let userCounter = 0;
async function registerUser(): Promise<string> {
  userCounter += 1;
  const response = await app.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: {
      email: `ads-${String(userCounter)}@example.test`,
      username: `ads${String(userCounter)}`,
      password: "hunter2hunter2",
    },
  });
  expect(response.statusCode).toBe(201);
  return response.json<{ accessToken: string }>().accessToken;
}

async function createIdentity(token: string): Promise<string> {
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
  return identity!.id;
}

function putAds(
  token: string,
  identityId: string,
  payload: object,
): Promise<ReturnType<FastifyInstance["inject"]>> {
  return app.inject({
    method: "PUT",
    url: `/api/identities/${identityId}/ads`,
    headers: { authorization: `Bearer ${token}` },
    payload,
  });
}

describe("ad library REST", () => {
  it("round-trips a library in order, normalizing Horizon-style", async () => {
    const token = await registerUser();
    const identityId = await createIdentity(token);

    const empty = await app.inject({
      method: "GET",
      url: `/api/identities/${identityId}/ads`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(empty.statusCode).toBe(200);
    expect(empty.json<{ ads: AdDto[] }>().ads).toEqual([]);

    const put = await putAds(token, identityId, {
      ads: [
        {
          content: "  first ad  ",
          tags: [" scene ", "scene", ""],
          disabled: false,
        },
        { content: "second ad", tags: [], disabled: true },
        { content: "   ", tags: ["dropped"], disabled: false },
      ],
    });
    expect(put.statusCode).toBe(200);
    const saved = put.json<{ ads: AdDto[] }>().ads;
    expect(saved).toHaveLength(2);
    expect(saved[0]).toMatchObject({
      content: "first ad",
      tags: ["scene"],
      disabled: false,
    });
    // A tagless ad gets "default" (Horizon behavior); order is preserved.
    expect(saved[1]).toMatchObject({
      content: "second ad",
      tags: ["default"],
      disabled: true,
    });

    const reread = await app.inject({
      method: "GET",
      url: `/api/identities/${identityId}/ads`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(reread.json<{ ads: AdDto[] }>().ads).toEqual(saved);
  });

  it("enforces the knownIds compare-and-set", async () => {
    const token = await registerUser();
    const identityId = await createIdentity(token);

    const first = await putAds(token, identityId, {
      ads: [{ content: "one", tags: ["a"], disabled: false }],
    });
    const ids = first.json<{ ads: AdDto[] }>().ads.map((ad) => ad.id);

    // A stale tab that loaded before `first` (no ids) must 409...
    const stale = await putAds(token, identityId, {
      ads: [{ content: "clobber", tags: [], disabled: false }],
      knownIds: [],
    });
    expect(stale.statusCode).toBe(409);

    // ...while the current tab replaces cleanly.
    const fresh = await putAds(token, identityId, {
      ads: [{ content: "two", tags: [], disabled: false }],
      knownIds: ids,
    });
    expect(fresh.statusCode).toBe(200);
    expect(fresh.json<{ ads: AdDto[] }>().ads[0]).toMatchObject({
      content: "two",
    });
  });

  it("scopes by ownership — another user's identity is a 404", async () => {
    const owner = await registerUser();
    const identityId = await createIdentity(owner);
    const intruder = await registerUser();

    const get = await app.inject({
      method: "GET",
      url: `/api/identities/${identityId}/ads`,
      headers: { authorization: `Bearer ${intruder}` },
    });
    expect(get.statusCode).toBe(404);

    const put = await putAds(intruder, identityId, {
      ads: [{ content: "nope", tags: [], disabled: false }],
    });
    expect(put.statusCode).toBe(404);
  });
});
