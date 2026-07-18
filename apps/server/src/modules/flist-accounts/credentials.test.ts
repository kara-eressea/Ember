// At-rest credential storage + boot resume (M9, decisions.md §15) against
// real Postgres + fchat-sim: the remember opt-in stores ciphertext (never
// the password), a second server process on the same database unlocks and
// reconnects autoConnect identities on boot, the detached-disconnect
// ceiling gates the resume, and a key-less server hides the feature.

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { FchatSim } from "@emberchat/fchat-sim";
import { buildApp } from "../../app.js";
import { loadConfig } from "../../config.js";
import { createDb, type Db } from "../../db/index.js";
import { flistCredentials, identities } from "../../db/schema.js";
import { FlistApiClient } from "../flist-api/api-client.js";

const MIGRATIONS = fileURLToPath(new URL("../../../drizzle", import.meta.url));
const ACCOUNT = "willow@example.test";
const CHARACTER = "Willow Reed";
const CHARACTER_B = "Fern Ashwood";
const PASSWORD = "hunter2";
const KEY = Buffer.alloc(32, 7).toString("base64url");

vi.setConfig({ testTimeout: 30_000 });

let container: StartedPostgreSqlContainer;
let db: Db;
let pool: { end: () => Promise<void> };
let sim: FchatSim;
let app: FastifyInstance;
let token: string;
let accountId: string;

function appConfig(overrides: Record<string, string> = {}) {
  const env: Record<string, string> = {
    DATABASE_URL: container.getConnectionUri(),
    AUTH_SECRET: "integration-test-secret-0123456789abcdef",
    AUTH_RATE_LIMIT_MAX: "1000",
    RATE_LIMIT_MAX: "10000",
    REGISTRATION_ENABLED: "true",
    FCHAT_URL: sim.wsUrl,
    FLIST_API_URL: sim.httpUrl,
    CREDENTIALS_KEY: KEY,
    ...overrides,
  };
  if (env["CREDENTIALS_KEY"] === "") {
    // "" is this file's sentinel for "unset" — the schema refuses empties.
    delete env["CREDENTIALS_KEY"];
  }
  return loadConfig(env);
}

function makeApp(overrides: Record<string, string> = {}) {
  return buildApp({
    config: appConfig(overrides),
    db,
    logger: false,
    flistApiClient: new FlistApiClient({
      baseUrl: sim.httpUrl,
      minRequestIntervalMs: 0,
    }),
  });
}

beforeAll(async () => {
  sim = new FchatSim();
  await sim.start();
  container = await new PostgreSqlContainer("postgres:18-alpine").start();
  ({ db, pool } = createDb(container.getConnectionUri()));
  await migrate(db, { migrationsFolder: MIGRATIONS });
  app = await makeApp();

  const registered = await app.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: {
      username: "cred-tester",
      email: "credentials@example.test",
      password: "correct-horse-battery",
    },
  });
  expect(registered.statusCode).toBe(201);
  token = registered.json<{ accessToken: string }>().accessToken;
}, 180_000);

afterAll(async () => {
  await app.close();
  await pool.end();
  await container.stop();
  await sim.stop();
});

const auth = () => ({ authorization: `Bearer ${token}` });

it("remember opt-in stores ciphertext, never the password", async () => {
  const list = await app.inject({
    method: "GET",
    url: "/api/flist-accounts",
    headers: auth(),
  });
  expect(list.json<{ canRemember: boolean }>().canRemember).toBe(true);

  const added = await app.inject({
    method: "POST",
    url: "/api/flist-accounts",
    headers: auth(),
    payload: { accountName: ACCOUNT, password: PASSWORD, remember: true },
  });
  expect(added.statusCode).toBe(201);
  const account = added.json<{
    account: { id: string; remembered: boolean };
  }>().account;
  expect(account.remembered).toBe(true);
  accountId = account.id;

  const [row] = await db
    .select()
    .from(flistCredentials)
    .where(eq(flistCredentials.accountId, accountId));
  expect(row).toBeDefined();
  expect(row!.ciphertext).not.toContain(PASSWORD);
});

it("the remember toggle removes and (unlocked) restores the stored row", async () => {
  const off = await app.inject({
    method: "PUT",
    url: `/api/flist-accounts/${accountId}/remember`,
    headers: auth(),
    payload: { remember: false },
  });
  expect(off.statusCode).toBe(200);
  expect(
    await db
      .select()
      .from(flistCredentials)
      .where(eq(flistCredentials.accountId, accountId)),
  ).toHaveLength(0);

  // The vault still holds the add-time password, so re-enabling works
  // without re-entering it.
  const on = await app.inject({
    method: "PUT",
    url: `/api/flist-accounts/${accountId}/remember`,
    headers: auth(),
    payload: { remember: true },
  });
  expect(on.statusCode).toBe(200);
  expect(
    on.json<{ account: { remembered: boolean } }>().account.remembered,
  ).toBe(true);
});

it("boot resume reconnects autoConnect identities; the ceiling gates it", async () => {
  const dayMs = 24 * 60 * 60 * 1000;
  const [resumable] = await db
    .insert(identities)
    .values({
      flistAccountId: accountId,
      characterName: CHARACTER,
      autoConnect: true,
      // Detached 1h ago — well inside the 72h window.
      lastDetachedAt: new Date(Date.now() - 60 * 60 * 1000),
    })
    .returning({ id: identities.id });
  const [expired] = await db
    .insert(identities)
    .values({
      flistAccountId: accountId,
      characterName: CHARACTER_B,
      autoConnect: true,
      // Detached four days ago — past the default 72h ceiling.
      lastDetachedAt: new Date(Date.now() - 4 * dayMs),
    })
    .returning({ id: identities.id });

  // "Restart": a fresh server process over the same database. Resume is
  // fire-and-forget on build, so poll for the session to come online.
  const second = await makeApp();
  try {
    const deadline = Date.now() + 15_000;
    for (;;) {
      const session = second.sessions.get(resumable!.id);
      if (session?.status === "online") {
        break;
      }
      if (Date.now() > deadline) {
        throw new Error(
          `resumed session never came online (${String(session?.status)})`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    // The expired identity stayed down — ghosts are not resurrected.
    expect(second.sessions.get(expired!.id)).toBeUndefined();
  } finally {
    await second.close();
  }
});

it("without CREDENTIALS_KEY: enabling refuses, but a stored row stays visible and deletable", async () => {
  const keyless = await makeApp({ CREDENTIALS_KEY: "" });
  try {
    const list = await keyless.inject({
      method: "GET",
      url: "/api/flist-accounts",
      headers: auth(),
    });
    const body = list.json<{
      canRemember: boolean;
      accounts: { id: string; remembered: boolean }[];
    }>();
    expect(body.canRemember).toBe(false);
    // The row stored while the key existed is not silently hidden (audit).
    expect(
      body.accounts.find((account) => account.id === accountId)?.remembered,
    ).toBe(true);

    const enable = await keyless.inject({
      method: "PUT",
      url: `/api/flist-accounts/${accountId}/remember`,
      headers: auth(),
      payload: { remember: true },
    });
    expect(enable.statusCode).toBe(409);

    // Deleting needs no key — the ciphertext is the user's to revoke.
    const disable = await keyless.inject({
      method: "PUT",
      url: `/api/flist-accounts/${accountId}/remember`,
      headers: auth(),
      payload: { remember: false },
    });
    expect(disable.statusCode).toBe(200);
    expect(
      await db
        .select()
        .from(flistCredentials)
        .where(eq(flistCredentials.accountId, accountId)),
    ).toHaveLength(0);
  } finally {
    await keyless.close();
  }
});
