// Ad-ratings REST (M11 step 2): full-app integration against real
// Postgres (testcontainers). Covers the upsert round-trip, note trimming,
// per-user isolation, validation bounds, and delete semantics. Ratings
// are per app user (no identity in the path) — nothing here touches the
// sim beyond app boot.

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { FchatSim } from "@emberchat/fchat-sim";
import type { RatingDto } from "@emberchat/protocol";
import { buildApp } from "../../app.js";
import { loadConfig } from "../../config.js";
import { createDb, type Db } from "../../db/index.js";
import { FlistApiClient } from "../flist-api/api-client.js";

const MIGRATIONS = fileURLToPath(new URL("../../../drizzle", import.meta.url));

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
      email: `ratings-${String(userCounter)}@example.test`,
      username: `ratings${String(userCounter)}`,
      password: "hunter2hunter2",
    },
  });
  expect(response.statusCode).toBe(201);
  return response.json<{ accessToken: string }>().accessToken;
}

function putRating(
  token: string,
  character: string,
  payload: object,
): Promise<ReturnType<FastifyInstance["inject"]>> {
  return app.inject({
    method: "PUT",
    url: `/api/ad-ratings/${encodeURIComponent(character)}`,
    headers: { authorization: `Bearer ${token}` },
    payload,
  });
}

function listRatings(
  token: string,
): Promise<ReturnType<FastifyInstance["inject"]>> {
  return app.inject({
    method: "GET",
    url: "/api/ad-ratings/",
    headers: { authorization: `Bearer ${token}` },
  });
}

describe("ad ratings REST", () => {
  it("upserts by character, trims notes, and lists sorted", async () => {
    const token = await registerUser();

    const empty = await listRatings(token);
    expect(empty.statusCode).toBe(200);
    expect(empty.json<{ ratings: RatingDto[] }>().ratings).toEqual([]);

    const first = await putRating(token, "Kolvarr", {
      score: 4,
      note: "  paragraph replies  ",
    });
    expect(first.statusCode).toBe(200);
    expect(first.json<{ rating: RatingDto }>().rating).toMatchObject({
      character: "Kolvarr",
      score: 4,
      note: "paragraph replies",
    });

    await putRating(token, "Amber Vale", { score: 2 });
    // Same character, different case: an update, not a second row —
    // display case follows the latest write.
    const updated = await putRating(token, "KOLVARR", { score: 5, note: "" });
    expect(updated.json<{ rating: RatingDto }>().rating).toMatchObject({
      character: "KOLVARR",
      score: 5,
    });
    expect(updated.json<{ rating: RatingDto }>().rating.note).toBeUndefined();

    const list = await listRatings(token);
    const ratings = list.json<{ ratings: RatingDto[] }>().ratings;
    expect(ratings.map((r) => [r.character, r.score])).toEqual([
      ["Amber Vale", 2],
      ["KOLVARR", 5],
    ]);
  });

  it("keeps users' ratings isolated and refuses bad input", async () => {
    const alice = await registerUser();
    const bob = await registerUser();
    await putRating(alice, "Marrow", { score: 1, note: "ghosted twice" });

    const bobsList = await listRatings(bob);
    expect(bobsList.json<{ ratings: RatingDto[] }>().ratings).toEqual([]);

    expect((await putRating(alice, "Marrow", { score: 0 })).statusCode).toBe(
      400,
    );
    expect((await putRating(alice, "Marrow", { score: 6 })).statusCode).toBe(
      400,
    );
    expect((await putRating(alice, "Marrow", { score: 2.5 })).statusCode).toBe(
      400,
    );
    expect((await putRating(alice, "Bad/Name", { score: 3 })).statusCode).toBe(
      400,
    );
    expect(
      (await putRating(alice, "Marrow", { score: 3, note: "x".repeat(501) }))
        .statusCode,
    ).toBe(400);

    const unauthenticated = await app.inject({
      method: "GET",
      url: "/api/ad-ratings/",
    });
    expect(unauthenticated.statusCode).toBe(401);
  });

  it("deletes a rating once, then 404s", async () => {
    const token = await registerUser();
    await putRating(token, "Thistle", { score: 5 });

    const del = await app.inject({
      method: "DELETE",
      url: "/api/ad-ratings/Thistle",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(del.statusCode).toBe(204);

    const again = await app.inject({
      method: "DELETE",
      url: "/api/ad-ratings/Thistle",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(again.statusCode).toBe(404);

    const list = await listRatings(token);
    expect(list.json<{ ratings: RatingDto[] }>().ratings).toEqual([]);
  });
});
