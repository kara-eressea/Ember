// Integration tests against real Postgres (testcontainers). One container +
// one app instance for the suite; the rate-limit test builds its own app so
// its counters stay isolated.

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../app.js";
import { loadConfig } from "../../config.js";
import { createDb, type Db } from "../../db/index.js";
import { appUsers } from "../../db/schema.js";

const MIGRATIONS = fileURLToPath(new URL("../../../drizzle", import.meta.url));

let container: StartedPostgreSqlContainer;
let db: Db;
let pool: { end: () => Promise<void> };
let app: FastifyInstance;

function testConfig(
  databaseUrl: string,
  overrides: Record<string, string> = {},
) {
  return loadConfig({
    DATABASE_URL: databaseUrl,
    AUTH_SECRET: "integration-test-secret-0123456789abcdef",
    AUTH_RATE_LIMIT_MAX: "1000",
    ...overrides,
  });
}

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:18-alpine").start();
  ({ db, pool } = createDb(container.getConnectionUri()));
  await migrate(db, { migrationsFolder: MIGRATIONS });
  app = await buildApp({
    config: testConfig(container.getConnectionUri()),
    db,
    logger: false,
  });
}, 180_000);

afterAll(async () => {
  await app.close();
  await pool.end();
  await container.stop();
});

interface TokenPair {
  user: { id: string; email: string; username: string; createdAt: string };
  accessToken: string;
  refreshToken: string;
}

let counter = 0;
async function registerUser(): Promise<TokenPair> {
  counter += 1;
  const response = await app.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: {
      email: `user${counter}@example.test`,
      username: `user${counter}`,
      password: "correct horse battery staple",
    },
  });
  expect(response.statusCode).toBe(201);
  return response.json<TokenPair>();
}

describe("register", () => {
  it("creates a user and returns a session", async () => {
    const body = await registerUser();
    expect(body.user).toMatchObject({
      email: `user${counter}@example.test`,
      username: `user${counter}`,
    });
    expect(body.accessToken).toBeTruthy();
    expect(body.refreshToken).toBeTruthy();
    expect(JSON.stringify(body)).not.toContain("passwordHash");
  });

  it("stores an argon2id hash, never the password", async () => {
    const body = await registerUser();
    const [row] = await db
      .select()
      .from(appUsers)
      .where(eq(appUsers.id, body.user.id));
    expect(row?.passwordHash).toMatch(/^\$argon2id\$/);
    expect(row?.passwordHash).not.toContain("correct horse");
  });

  it("rejects duplicate emails with 409", async () => {
    const body = await registerUser();
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: {
        email: body.user.email,
        username: "someoneelse",
        password: "password123",
      },
    });
    expect(response.statusCode).toBe(409);
  });

  it("rejects invalid bodies with 400", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { email: "not-an-email", username: "x", password: "short" },
    });
    expect(response.statusCode).toBe(400);
  });
});

describe("login", () => {
  it("returns a session for valid credentials (email is case-insensitive)", async () => {
    const { user } = await registerUser();
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: {
        email: user.email.toUpperCase(),
        password: "correct horse battery staple",
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<TokenPair>().user.id).toBe(user.id);
  });

  it("rejects a wrong password and an unknown email identically", async () => {
    const { user } = await registerUser();
    const wrongPassword = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: user.email, password: "wrong password" },
    });
    const unknownEmail = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "nobody@example.test", password: "wrong password" },
    });
    expect(wrongPassword.statusCode).toBe(401);
    expect(unknownEmail.statusCode).toBe(401);
    expect(wrongPassword.json()).toEqual(unknownEmail.json());
  });
});

describe("access tokens", () => {
  it("grants /me with a valid token and rejects missing/garbage tokens", async () => {
    const { user, accessToken } = await registerUser();
    const ok = await app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json<{ user: { id: string } }>().user.id).toBe(user.id);

    expect(
      (await app.inject({ method: "GET", url: "/api/auth/me" })).statusCode,
    ).toBe(401);
    const garbage = await app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: { authorization: "Bearer not.a.jwt" },
    });
    expect(garbage.statusCode).toBe(401);
  });
});

describe("refresh rotation", () => {
  it("rotates the refresh token and rejects the previous one", async () => {
    const { refreshToken } = await registerUser();
    const first = await app.inject({
      method: "POST",
      url: "/api/auth/refresh",
      payload: { refreshToken },
    });
    expect(first.statusCode).toBe(200);
    const rotated = first.json<{ accessToken: string; refreshToken: string }>();
    expect(rotated.refreshToken).not.toBe(refreshToken);

    // The redeemed token is dead.
    const replay = await app.inject({
      method: "POST",
      url: "/api/auth/refresh",
      payload: { refreshToken },
    });
    expect(replay.statusCode).toBe(401);

    // The rotated token works.
    const second = await app.inject({
      method: "POST",
      url: "/api/auth/refresh",
      payload: { refreshToken: rotated.refreshToken },
    });
    expect(second.statusCode).toBe(200);
  });

  it("rejects unknown refresh tokens", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/refresh",
      payload: { refreshToken: "definitely-not-issued" },
    });
    expect(response.statusCode).toBe(401);
  });
});

describe("logout", () => {
  it("kills the session so its refresh token stops working", async () => {
    const { refreshToken } = await registerUser();
    const logout = await app.inject({
      method: "POST",
      url: "/api/auth/logout",
      payload: { refreshToken },
    });
    expect(logout.statusCode).toBe(204);
    const refresh = await app.inject({
      method: "POST",
      url: "/api/auth/refresh",
      payload: { refreshToken },
    });
    expect(refresh.statusCode).toBe(401);
  });
});

describe("rate limiting", () => {
  it("returns 429 after the per-route auth limit", async () => {
    const limited = await buildApp({
      config: testConfig(container.getConnectionUri(), {
        AUTH_RATE_LIMIT_MAX: "3",
      }),
      db,
      logger: false,
    });
    try {
      const attempt = () =>
        limited.inject({
          method: "POST",
          url: "/api/auth/login",
          payload: { email: "nobody@example.test", password: "wrong password" },
        });
      for (let i = 0; i < 3; i += 1) {
        expect((await attempt()).statusCode).toBe(401);
      }
      expect((await attempt()).statusCode).toBe(429);
    } finally {
      await limited.close();
    }
  });
});
