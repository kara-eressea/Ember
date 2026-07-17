// Eicon index + search against real Postgres + fchat-sim: the server-side
// pref gate (403 when off), full base.doc download, case-insensitive
// grep, delta refresh, and the persisted-index restart path (a fresh
// service with an unreachable upstream must serve from the DB row).

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
import { userPreferences } from "../../db/schema.js";
import { EiconIndexService } from "./index-service.js";

const MIGRATIONS = fileURLToPath(new URL("../../../drizzle", import.meta.url));
const DAY_MS = 24 * 60 * 60 * 1000;

vi.setConfig({ testTimeout: 20_000 });

let container: StartedPostgreSqlContainer;
let db: Db;
let pool: { end: () => Promise<void> };
let sim: FchatSim;
let app: FastifyInstance;
let token: string;
let userId: string;

beforeAll(async () => {
  sim = new FchatSim();
  await sim.start();
  sim.setEiconIndex(
    ["campfire", "Ember Logo", "teacup", "tea.time", "lanternlight"],
    1_752_000_000,
  );
  container = await new PostgreSqlContainer("postgres:18-alpine").start();
  ({ db, pool } = createDb(container.getConnectionUri()));
  await migrate(db, { migrationsFolder: MIGRATIONS });
  app = await buildApp({
    config: loadConfig({
      DATABASE_URL: container.getConnectionUri(),
      AUTH_SECRET: "integration-test-secret-0123456789abcdef",
      AUTH_RATE_LIMIT_MAX: "1000",
      RATE_LIMIT_MAX: "10000",
      REGISTRATION_ENABLED: "true",
      FCHAT_URL: sim.wsUrl,
      FLIST_API_URL: sim.httpUrl,
      EICON_INDEX_BASE_URL: sim.httpUrl,
    }),
    db,
    logger: false,
  });

  const registered = await app.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: {
      username: "eicon-tester",
      email: "eicons@example.test",
      password: "correct-horse-battery",
    },
  });
  expect(registered.statusCode).toBe(201);
  const body = registered.json<{
    user: { id: string };
    accessToken: string;
  }>();
  token = body.accessToken;
  userId = body.user.id;
});

afterAll(async () => {
  await app.close();
  await pool.end();
  await container.stop();
  await sim.stop();
});

function search(query: string) {
  return app.inject({
    method: "GET",
    url: `/api/eicons/search?q=${encodeURIComponent(query)}`,
    headers: { authorization: `Bearer ${token}` },
  });
}

describe("eicon search route", () => {
  it("is a real server-side gate: 403 while the pref is off", async () => {
    const response = await search("tea");
    expect(response.statusCode).toBe(403);
  });

  it("serves case-insensitive substring matches once enabled", async () => {
    await db
      .insert(userPreferences)
      .values({ userId, prefs: { eiconSearchEnabled: true } })
      .onConflictDoUpdate({
        target: userPreferences.userId,
        set: { prefs: { eiconSearchEnabled: true } },
      });
    const response = await search("TEA");
    expect(response.statusCode).toBe(200);
    expect(response.json<{ results: string[] }>().results).toEqual([
      "teacup",
      "tea.time",
    ]);
  });

  it("rejects an empty query at the schema", async () => {
    const response = await search("");
    expect(response.statusCode).toBe(400);
  });
});

describe("EiconIndexService", () => {
  it("applies +/- deltas once the refresh window lapses", async () => {
    // Baseline on real time: the route tests above already persisted an
    // index row stamped with wall-clock fetchedAt, which this service
    // adopts instead of re-downloading.
    let nowMs = Date.now();
    const service = new EiconIndexService({
      db,
      baseUrl: sim.httpUrl,
      refreshMs: DAY_MS,
      now: () => nowMs,
    });
    expect(await service.search("camp")).toEqual(["campfire"]);
    sim.addEiconDelta("+", "campsite", 1_752_000_100);
    sim.addEiconDelta("-", "campfire", 1_752_000_200);
    // Within the window nothing refetches — the index is served as-is.
    expect(await service.search("camp")).toEqual(["campfire"]);
    nowMs += DAY_MS + 1;
    expect(await service.search("camp")).toEqual(["campsite"]);
    expect(service.state.asOf).toBe(1_752_000_200);
  });

  it("adopts the persisted index instead of re-downloading on restart", async () => {
    // The previous test persisted post-delta state; a fresh service pointed
    // at an unreachable upstream must still answer from the DB row.
    const service = new EiconIndexService({
      db,
      baseUrl: "http://127.0.0.1:1",
      refreshMs: DAY_MS,
      now: () => Date.now() + DAY_MS + 60_000,
    });
    expect(await service.search("campsite")).toEqual(["campsite"]);
    expect(await service.search("ember")).toEqual(["Ember Logo"]);
  });
});
