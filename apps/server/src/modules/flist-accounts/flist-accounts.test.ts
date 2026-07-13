// Integration tests: real Postgres (testcontainers) + fchat-sim's fake
// getApiTicket.php as the F-List stand-in. The app logs into a capture
// stream so we can assert F-List passwords never appear in logs.

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import { FchatSim } from "@emberchat/fchat-sim";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { buildApp } from "../../app.js";
import { loadConfig } from "../../config.js";
import { createDb, type Db } from "../../db/index.js";
import { conversations, identities } from "../../db/schema.js";
import { FlistApiClient } from "../flist-api/api-client.js";

const MIGRATIONS = fileURLToPath(new URL("../../../drizzle", import.meta.url));

let container: StartedPostgreSqlContainer;
let db: Db;
let pool: { end: () => Promise<void> };
let sim: FchatSim;
let app: FastifyInstance;
const logLines: string[] = [];

async function makeApp(): Promise<FastifyInstance> {
  const config = loadConfig({
    DATABASE_URL: container.getConnectionUri(),
    AUTH_SECRET: "integration-test-secret-0123456789abcdef",
    AUTH_RATE_LIMIT_MAX: "1000",
    FLIST_API_URL: sim.httpUrl,
    FCHAT_URL: sim.wsUrl,
  });
  return buildApp({
    config,
    db,
    logger: {
      level: "info",
      stream: new Writable({
        write(chunk: Buffer, _encoding, callback) {
          logLines.push(chunk.toString());
          callback();
        },
      }),
    },
    // No request throttle in tests — the budget logic has its own unit test.
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
}, 180_000);

afterAll(async () => {
  await app.close();
  await pool.end();
  await container.stop();
  await sim.stop();
});

let counter = 0;
async function registerUser(target: FastifyInstance = app): Promise<string> {
  counter += 1;
  const response = await target.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: {
      email: `flist${counter}@example.test`,
      username: `flist${counter}`,
      password: "app account password",
    },
  });
  expect(response.statusCode).toBe(201);
  return response.json<{ accessToken: string }>().accessToken;
}

function authed(token: string) {
  return { authorization: `Bearer ${token}` };
}

async function addAccount(token: string, target: FastifyInstance = app) {
  const response = await target.inject({
    method: "POST",
    url: "/api/flist-accounts",
    headers: authed(token),
    payload: { accountName: "amber@example.test", password: "hunter2" },
  });
  expect(response.statusCode).toBe(201);
  return response.json<{ account: { id: string }; characters: string[] }>();
}

describe("add account", () => {
  it("verifies the password against F-List and returns the character list", async () => {
    const token = await registerUser();
    const body = await addAccount(token);
    expect(body.account).toMatchObject({
      accountName: "amber@example.test",
      unlocked: true,
    });
    expect(body.characters).toEqual(["Amber Vale", "Cindral"]);
  });

  it("rejects a wrong password with 401 and rolls the row back", async () => {
    const token = await registerUser();
    const response = await app.inject({
      method: "POST",
      url: "/api/flist-accounts",
      headers: authed(token),
      payload: { accountName: "amber@example.test", password: "wrong" },
    });
    expect(response.statusCode).toBe(401);
    const list = await app.inject({
      method: "GET",
      url: "/api/flist-accounts",
      headers: authed(token),
    });
    expect(list.json<{ accounts: unknown[] }>().accounts).toHaveLength(0);
  });

  it("rejects adding the same account twice with 409", async () => {
    const token = await registerUser();
    await addAccount(token);
    const again = await app.inject({
      method: "POST",
      url: "/api/flist-accounts",
      headers: authed(token),
      payload: { accountName: "amber@example.test", password: "hunter2" },
    });
    expect(again.statusCode).toBe(409);
  });

  it("requires authentication", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/flist-accounts",
      payload: { accountName: "amber@example.test", password: "hunter2" },
    });
    expect(response.statusCode).toBe(401);
  });
});

describe("characters proxy", () => {
  it("returns the account's characters", async () => {
    const token = await registerUser();
    const { account } = await addAccount(token);
    const response = await app.inject({
      method: "GET",
      url: `/api/flist-accounts/${account.id}/characters`,
      headers: authed(token),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ characters: ["Amber Vale", "Cindral"] });
  });

  it("is invisible to other users", async () => {
    const owner = await registerUser();
    const { account } = await addAccount(owner);
    const stranger = await registerUser();
    for (const [method, url] of [
      ["GET", `/api/flist-accounts/${account.id}/characters`],
      ["POST", `/api/flist-accounts/${account.id}/unlock`],
      ["DELETE", `/api/flist-accounts/${account.id}`],
    ] as const) {
      const response = await app.inject({
        method,
        url,
        headers: authed(stranger),
        ...(method === "POST" ? { payload: { password: "hunter2" } } : {}),
      });
      expect(response.statusCode).toBe(404);
    }
  });
});

describe("restart + unlock", () => {
  it("locks accounts on restart; unlock re-verifies and reseeds the vault", async () => {
    const token = await registerUser();
    const { account } = await addAccount(token);

    // A new app instance = a restarted server: same DB, empty vault.
    const restarted = await makeApp();
    try {
      const locked = await app.inject({
        method: "GET",
        url: `/api/flist-accounts/${account.id}/characters`,
        headers: authed(token),
      });
      expect(locked.statusCode).toBe(200); // original app still has the vault

      const lockedOnRestart = await restarted.inject({
        method: "GET",
        url: `/api/flist-accounts/${account.id}/characters`,
        headers: authed(token),
      });
      expect(lockedOnRestart.statusCode).toBe(423);

      const list = await restarted.inject({
        method: "GET",
        url: "/api/flist-accounts",
        headers: authed(token),
      });
      expect(
        list.json<{ accounts: { unlocked: boolean }[] }>().accounts[0]
          ?.unlocked,
      ).toBe(false);

      const badUnlock = await restarted.inject({
        method: "POST",
        url: `/api/flist-accounts/${account.id}/unlock`,
        headers: authed(token),
        payload: { password: "wrong" },
      });
      expect(badUnlock.statusCode).toBe(401);

      const unlock = await restarted.inject({
        method: "POST",
        url: `/api/flist-accounts/${account.id}/unlock`,
        headers: authed(token),
        payload: { password: "hunter2" },
      });
      expect(unlock.statusCode).toBe(200);
      expect(
        unlock.json<{ account: { unlocked: boolean } }>().account.unlocked,
      ).toBe(true);

      const characters = await restarted.inject({
        method: "GET",
        url: `/api/flist-accounts/${account.id}/characters`,
        headers: authed(token),
      });
      expect(characters.statusCode).toBe(200);
    } finally {
      await restarted.close();
    }
  });

  it("one unlock reconnects every autoConnect identity with its channels (restart recovery)", async () => {
    const token = await registerUser();
    const { account } = await addAccount(token);
    // One identity was online when the server went down (autoConnect), one
    // the user had explicitly logged off.
    const [wanted] = await db
      .insert(identities)
      .values({
        flistAccountId: account.id,
        characterName: "Amber Vale",
        autoConnect: true,
      })
      .returning();
    const [dormant] = await db
      .insert(identities)
      .values({
        flistAccountId: account.id,
        characterName: "Cindral",
        autoConnect: false,
      })
      .returning();
    // The joined flags the history sink had persisted before the restart.
    await db.insert(conversations).values([
      {
        identityId: wanted!.id,
        kind: "channel",
        channelKey: "Frontpage",
        title: "Frontpage",
        joined: true,
      },
      {
        identityId: wanted!.id,
        kind: "channel",
        channelKey: "Development",
        title: "Development",
        joined: false,
      },
    ]);

    const restarted = await makeApp();
    try {
      const unlock = await restarted.inject({
        method: "POST",
        url: `/api/flist-accounts/${account.id}/unlock`,
        headers: authed(token),
        payload: { password: "hunter2" },
      });
      expect(unlock.statusCode).toBe(200);
      expect(unlock.json<{ reconnected: string[] }>().reconnected).toEqual([
        wanted!.id,
      ]);

      // The autoConnect identity comes back online in exactly the channels
      // it was in (decisions.md §9 scenario 2); the logged-off one stays out.
      const session = restarted.sessions.get(wanted!.id);
      expect(session).toBeDefined();
      expect(restarted.sessions.get(dormant!.id)).toBeUndefined();
      await vi.waitFor(
        () => {
          expect(session!.status).toBe("online");
          expect(session!.state.channels.has("Frontpage")).toBe(true);
        },
        { timeout: 10_000 },
      );
      expect(session!.state.channels.has("Development")).toBe(false);
    } finally {
      await restarted.close();
    }
  });
});

describe("delete", () => {
  it("removes the account and locks it out", async () => {
    const token = await registerUser();
    const { account } = await addAccount(token);
    const del = await app.inject({
      method: "DELETE",
      url: `/api/flist-accounts/${account.id}`,
      headers: authed(token),
    });
    expect(del.statusCode).toBe(204);
    const characters = await app.inject({
      method: "GET",
      url: `/api/flist-accounts/${account.id}/characters`,
      headers: authed(token),
    });
    expect(characters.statusCode).toBe(404);
    const list = await app.inject({
      method: "GET",
      url: "/api/flist-accounts",
      headers: authed(token),
    });
    expect(list.json<{ accounts: unknown[] }>().accounts).toHaveLength(0);
  });
});

describe("secrets hygiene", () => {
  it("never writes an F-List password to the logs", () => {
    // Runs last: every add/unlock above (including failures) has logged by now.
    expect(logLines.length).toBeGreaterThan(0);
    const all = logLines.join("");
    expect(all).not.toContain("hunter2");
    expect(all).not.toContain("app account password");
  });
});
