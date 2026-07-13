// Identities CRUD integration tests against real Postgres + fchat-sim.

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
import { MAX_IDENTITIES_PER_USER } from "./routes.js";

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

  it("caps identities per user", async () => {
    const { token, accountId } = await setupUser();
    // Seed the cap directly — the sim account only carries two characters.
    await db.insert(identities).values(
      Array.from({ length: MAX_IDENTITIES_PER_USER }, (_, i) => ({
        flistAccountId: accountId,
        characterName: `Filler ${String(i)}`,
        autoConnect: false,
        sortOrder: i,
      })),
    );
    const refused = await createIdentity(token, accountId, "Amber Vale");
    expect(refused.statusCode).toBe(422);
    expect(refused.json<{ error: string }>().error).toMatch(/identities/i);
  });

  it("assigns rail order on create and reorders via PUT /order", async () => {
    const { token, accountId } = await setupUser();
    const first = await createIdentity(token, accountId, "Amber Vale");
    const second = await createIdentity(token, accountId, "Cindral");
    // New identities join the end of the rail.
    expect(
      first.json<{ identity: { sortOrder: number } }>().identity,
    ).toMatchObject({ sortOrder: 0 });
    expect(
      second.json<{ identity: { sortOrder: number } }>().identity,
    ).toMatchObject({ sortOrder: 1 });
    const firstId = first.json<{ identity: { id: string } }>().identity.id;
    const secondId = second.json<{ identity: { id: string } }>().identity.id;

    // Not a permutation (missing an id): refused, nothing scrambled.
    const partial = await app.inject({
      method: "PUT",
      url: "/api/identities/order",
      headers: { authorization: `Bearer ${token}` },
      payload: { ids: [secondId] },
    });
    expect(partial.statusCode).toBe(422);

    // Right length, but padded with a duplicate: refused.
    const duped = await app.inject({
      method: "PUT",
      url: "/api/identities/order",
      headers: { authorization: `Bearer ${token}` },
      payload: { ids: [secondId, secondId] },
    });
    expect(duped.statusCode).toBe(422);

    // Another user's identity can't ride along either.
    const stranger = await setupUser();
    const foreign = await createIdentity(
      stranger.token,
      stranger.accountId,
      "Amber Vale",
    );
    const foreignId = foreign.json<{ identity: { id: string } }>().identity.id;
    const smuggled = await app.inject({
      method: "PUT",
      url: "/api/identities/order",
      headers: { authorization: `Bearer ${token}` },
      payload: { ids: [foreignId, firstId] },
    });
    expect(smuggled.statusCode).toBe(422);

    const reordered = await app.inject({
      method: "PUT",
      url: "/api/identities/order",
      headers: { authorization: `Bearer ${token}` },
      payload: { ids: [secondId, firstId] },
    });
    expect(reordered.statusCode).toBe(204);

    const listed = await app.inject({
      method: "GET",
      url: "/api/identities",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(
      listed
        .json<{ identities: { characterName: string }[] }>()
        .identities.map((i) => i.characterName),
    ).toEqual(["Cindral", "Amber Vale"]);
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

  it("REST connect/disconnect drive the session and the autoConnect flag", async () => {
    const { token, accountId } = await setupUser();
    const created = await createIdentity(token, accountId, "Amber Vale");
    const identityId = created.json<{ identity: { id: string } }>().identity.id;

    const connected = await app.inject({
      method: "POST",
      url: `/api/identities/${identityId}/connect`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(connected.statusCode).toBe(200);
    const session = app.sessions.get(identityId);
    expect(session).toBeDefined();
    await vi.waitFor(
      () => {
        expect(session!.status).toBe("online");
      },
      { timeout: 10_000 },
    );

    const listed = await app.inject({
      method: "GET",
      url: "/api/identities",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(listed.json<{ identities: object[] }>().identities[0]).toMatchObject(
      { sessionStatus: "online", autoConnect: true },
    );

    const disconnected = await app.inject({
      method: "POST",
      url: `/api/identities/${identityId}/disconnect`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(disconnected.statusCode).toBe(200);
    expect(disconnected.json<{ identity: object }>().identity).toMatchObject({
      autoConnect: false,
      sessionStatus: "offline",
    });
    expect(app.sessions.get(identityId)).toBeUndefined();

    // A stranger can neither connect nor disconnect it.
    const { token: strangerToken } = await setupUser();
    for (const action of ["connect", "disconnect"]) {
      const foreign = await app.inject({
        method: "POST",
        url: `/api/identities/${identityId}/${action}`,
        headers: { authorization: `Bearer ${strangerToken}` },
      });
      expect(foreign.statusCode).toBe(404);
    }
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
