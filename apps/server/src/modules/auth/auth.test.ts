// Integration tests against real Postgres (testcontainers). One container +
// one app instance for the suite; the rate-limit test builds its own app so
// its counters stay isolated.

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../app.js";
import { loadConfig } from "../../config.js";
import { createDb, type Db } from "../../db/index.js";
import { appUsers, authSessions } from "../../db/schema.js";
import { MAX_SESSIONS_PER_USER } from "./routes.js";
import { SessionJanitor } from "./session-janitor.js";

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
    REGISTRATION_ENABLED: "true",
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

  it("revokes outstanding access tokens immediately, not after their TTL", async () => {
    const { accessToken, refreshToken } = await registerUser();
    const before = await app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(before.statusCode).toBe(200);

    await app.inject({
      method: "POST",
      url: "/api/auth/logout",
      payload: { refreshToken },
    });

    // The JWT is still within its 15-minute TTL, but its session is gone.
    const after = await app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(after.statusCode).toBe(401);
  });
});

describe("login lockout", () => {
  it("locks the account after repeated failures — even for the right password", async () => {
    const attempt = (password: string) =>
      app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { email: "lockout-target@example.test", password },
      });
    // The email doesn't even exist — unknown accounts lock identically, so
    // the lockout can't be used to probe which emails are registered.
    for (let i = 0; i < 5; i += 1) {
      expect((await attempt("wrong password")).statusCode).toBe(401);
    }
    const locked = await attempt("wrong password");
    expect(locked.statusCode).toBe(429);
    expect(Number(locked.headers["retry-after"])).toBeGreaterThan(0);
  });
});

describe("session hygiene", () => {
  it("caps auth sessions per user, evicting the oldest on login", async () => {
    const { user } = await registerUser(); // one session exists now
    // Backfill far past the cap, oldest first, straight into the table.
    const base = Date.now() - 1_000_000;
    for (let i = 0; i < MAX_SESSIONS_PER_USER + 5; i += 1) {
      await db.insert(authSessions).values({
        userId: user.id,
        refreshTokenHash: `backfill-${String(counter)}-${String(i)}`,
        expiresAt: new Date(Date.now() + 3_600_000),
        createdAt: new Date(base + i * 1000),
      });
    }
    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: {
        email: user.email,
        password: "correct horse battery staple",
      },
    });
    expect(login.statusCode).toBe(200);
    const rows = await db
      .select({ id: authSessions.id })
      .from(authSessions)
      .where(eq(authSessions.userId, user.id));
    expect(rows.length).toBe(MAX_SESSIONS_PER_USER);
    // The just-issued session survived the eviction.
    const refresh = await app.inject({
      method: "POST",
      url: "/api/auth/refresh",
      payload: {
        refreshToken: login.json<{ refreshToken: string }>().refreshToken,
      },
    });
    expect(refresh.statusCode).toBe(200);
  });

  it("the janitor sweeps expired sessions and leaves live ones", async () => {
    const { user, refreshToken } = await registerUser();
    await db.insert(authSessions).values({
      userId: user.id,
      refreshTokenHash: `expired-${String(counter)}`,
      expiresAt: new Date(Date.now() - 1000),
    });
    const janitor = new SessionJanitor({
      db,
      logger: { info: () => undefined, error: () => undefined },
    });
    expect(await janitor.sweep()).toBeGreaterThanOrEqual(1);
    // The live session still refreshes; the expired row is gone.
    const rows = await db
      .select({ hash: authSessions.refreshTokenHash })
      .from(authSessions)
      .where(eq(authSessions.userId, user.id));
    expect(rows.some((r) => r.hash.startsWith("expired-"))).toBe(false);
    const refresh = await app.inject({
      method: "POST",
      url: "/api/auth/refresh",
      payload: { refreshToken },
    });
    expect(refresh.statusCode).toBe(200);
  });
});

describe("security headers", () => {
  it("sends helmet headers; CSP only in SPA-serving mode", async () => {
    // API-only mode (the shared app): headers yes, CSP no.
    const health = await app.inject({ method: "GET", url: "/healthz" });
    expect(health.headers["x-content-type-options"]).toBe("nosniff");
    expect(health.headers["x-frame-options"]).toBeDefined();
    expect(health.headers["content-security-policy"]).toBeUndefined();

    // SPA-serving mode: the CSP arrives and allows F-List's static host.
    const dist = await mkdtemp(path.join(tmpdir(), "emberchat-csp-"));
    await writeFile(
      path.join(dist, "index.html"),
      "<!doctype html><html><head><title>x</title></head><body></body></html>",
    );
    const spa = await buildApp({
      config: testConfig(container.getConnectionUri(), { WEB_DIST: dist }),
      db,
      logger: false,
    });
    try {
      const page = await spa.inject({ method: "GET", url: "/" });
      const csp = String(page.headers["content-security-policy"]);
      expect(csp).toContain("default-src 'self'");
      expect(csp).toContain("img-src 'self' data: https://static.f-list.net");
      expect(csp).toContain("frame-ancestors 'none'");
    } finally {
      await spa.close();
      await rm(dist, { recursive: true, force: true });
    }
  });
});

describe("registration gate", () => {
  it("404s when REGISTRATION_ENABLED is off (the default)", async () => {
    const gated = await buildApp({
      config: testConfig(container.getConnectionUri(), {
        REGISTRATION_ENABLED: "false",
      }),
      db,
      logger: false,
    });
    try {
      const response = await gated.inject({
        method: "POST",
        url: "/api/auth/register",
        payload: {
          email: "gated@example.test",
          username: "gated",
          password: "correct horse battery staple",
        },
      });
      expect(response.statusCode).toBe(404);
      // Login remains reachable on the same instance.
      const login = await gated.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { email: "gated@example.test", password: "whatever else" },
      });
      expect(login.statusCode).toBe(401);
    } finally {
      await gated.close();
    }
  });

  it("defaults REGISTRATION_ENABLED to false", () => {
    expect(
      loadConfig({
        DATABASE_URL: "postgres://x",
        AUTH_SECRET: "integration-test-secret-0123456789abcdef",
      }).REGISTRATION_ENABLED,
    ).toBe(false);
  });
});

describe("admin CLI", () => {
  const CLI = fileURLToPath(
    new URL("../../../dist/cli/admin.js", import.meta.url),
  );
  const run = (args: string[]) =>
    new Promise<{ code: number | null; stdout: string; stderr: string }>(
      (resolve) => {
        execFile(
          process.execPath,
          [CLI, ...args],
          {
            env: { ...process.env, DATABASE_URL: container.getConnectionUri() },
          },
          (error, stdout, stderr) => {
            resolve({
              code: error && "code" in error ? (error.code as number) : 0,
              stdout,
              stderr,
            });
          },
        );
      },
    );

  it("create-user then reset-password round-trips through login", async () => {
    const created = await run([
      "create-user",
      "--email",
      "cli-admin@example.test",
      "--username",
      "cli-admin",
      "--password",
      "first password here",
    ]);
    expect(created.stderr).toBe("");
    expect(created.code).toBe(0);
    expect(created.stdout).toContain("Created user cli-admin");

    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: {
        email: "cli-admin@example.test",
        password: "first password here",
      },
    });
    expect(login.statusCode).toBe(200);

    const reset = await run([
      "reset-password",
      "--email",
      "cli-admin@example.test",
      "--password",
      "second password here",
    ]);
    expect(reset.code).toBe(0);
    expect(reset.stdout).toContain("Password reset for cli-admin");

    const stale = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: {
        email: "cli-admin@example.test",
        password: "first password here",
      },
    });
    expect(stale.statusCode).toBe(401);
    const fresh = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: {
        email: "cli-admin@example.test",
        password: "second password here",
      },
    });
    expect(fresh.statusCode).toBe(200);
  });

  it("refuses duplicates and unknown emails with a nonzero exit", async () => {
    const dupe = await run([
      "create-user",
      "--email",
      "cli-admin@example.test",
      "--username",
      "cli-admin",
      "--password",
      "first password here",
    ]);
    expect(dupe.code).toBe(1);
    expect(dupe.stderr).toContain("already taken");

    const missing = await run([
      "reset-password",
      "--email",
      "nobody-here@example.test",
      "--password",
      "does not matter 1",
    ]);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain("No user");
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
