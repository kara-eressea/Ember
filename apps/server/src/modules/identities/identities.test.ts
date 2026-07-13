// Identities CRUD integration tests against real Postgres + fchat-sim.

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FchatSim } from "@emberchat/fchat-sim";
import { buildApp } from "../../app.js";
import { loadConfig } from "../../config.js";
import { createDb, type Db } from "../../db/index.js";
import { FlistApiClient } from "../flist-api/api-client.js";

const MIGRATIONS = fileURLToPath(new URL("../../../drizzle", import.meta.url));
const ACCOUNT = "amber@example.test";

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
/** Fresh app user with a vaulted F-List account; returns token + account id. */
async function setupUser(): Promise<{ token: string; accountId: string }> {
  userCounter += 1;
  const registered = await app.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: {
      email: `identities-${String(userCounter)}@example.test`,
      username: `identities${String(userCounter)}`,
      password: "hunter2hunter2",
    },
  });
  expect(registered.statusCode).toBe(201);
  const token = registered.json<{ accessToken: string }>().accessToken;
  const added = await app.inject({
    method: "POST",
    url: "/api/flist-accounts",
    headers: { authorization: `Bearer ${token}` },
    payload: { accountName: ACCOUNT, password: "hunter2" },
  });
  expect(added.statusCode).toBe(201);
  return {
    token,
    accountId: added.json<{ account: { id: string } }>().account.id,
  };
}

function createIdentity(token: string, accountId: string, character: string) {
  return app.inject({
    method: "POST",
    url: "/api/identities",
    headers: { authorization: `Bearer ${token}` },
    payload: { flistAccountId: accountId, characterName: character },
  });
}

describe("identities CRUD", () => {
  it("creates, lists, and rejects duplicates", async () => {
    const { token, accountId } = await setupUser();

    const created = await createIdentity(token, accountId, "Amber Vale");
    expect(created.statusCode).toBe(201);
    const identity = created.json<{ identity: { id: string } }>().identity;
    expect(identity).toMatchObject({
      flistAccountId: accountId,
      characterName: "Amber Vale",
      // A fresh identity's intent is to be online — it counts for unlock
      // auto-connect until an explicit disconnect clears it.
      autoConnect: true,
    });

    const second = await createIdentity(token, accountId, "Cindral");
    expect(second.statusCode).toBe(201);

    const duplicate = await createIdentity(token, accountId, "Amber Vale");
    expect(duplicate.statusCode).toBe(409);

    const listed = await app.inject({
      method: "GET",
      url: "/api/identities",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(listed.statusCode).toBe(200);
    expect(
      listed
        .json<{ identities: { characterName: string }[] }>()
        .identities.map((i) => i.characterName),
    ).toEqual(["Amber Vale", "Cindral"]);
  });

  it("rejects characters that are not on the account", async () => {
    const { token, accountId } = await setupUser();
    const response = await createIdentity(token, accountId, "Not My Character");
    expect(response.statusCode).toBe(422);
  });

  it("hides other users' accounts and identities", async () => {
    const { token, accountId } = await setupUser();
    const created = await createIdentity(token, accountId, "Amber Vale");
    const identityId = created.json<{ identity: { id: string } }>().identity.id;

    const { token: strangerToken } = await setupUser();
    const foreignCreate = await createIdentity(
      strangerToken,
      accountId,
      "Amber Vale",
    );
    expect(foreignCreate.statusCode).toBe(404);

    const foreignDelete = await app.inject({
      method: "DELETE",
      url: `/api/identities/${identityId}`,
      headers: { authorization: `Bearer ${strangerToken}` },
    });
    expect(foreignDelete.statusCode).toBe(404);

    const foreignList = await app.inject({
      method: "GET",
      url: "/api/identities",
      headers: { authorization: `Bearer ${strangerToken}` },
    });
    expect(foreignList.json<{ identities: unknown[] }>().identities).toEqual(
      [],
    );
  });

  it("deletes an identity and stops its running session", async () => {
    const { token, accountId } = await setupUser();
    const created = await createIdentity(token, accountId, "Amber Vale");
    const identityId = created.json<{ identity: { id: string } }>().identity.id;

    const session = app.sessions.start({
      identityId,
      character: "Amber Vale",
      accountId,
      accountName: ACCOUNT,
    });

    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/identities/${identityId}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(deleted.statusCode).toBe(204);
    expect(session.status).toBe("stopped");

    const listed = await app.inject({
      method: "GET",
      url: "/api/identities",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(listed.json<{ identities: unknown[] }>().identities).toEqual([]);
  });
});
