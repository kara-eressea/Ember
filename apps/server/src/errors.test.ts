// The error envelope (review round #558). Two leaks of internal text to the
// browser: Fastify's default error handler, which answers with the thrown
// error's own message — reachable unauthenticated, since /api/auth/login
// queries the database before it authenticates anything — and the F-List
// upstream mapper's fallthrough arm.

import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AccountLockedError } from "@emberchat/session-engine";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { upstreamStatus } from "./modules/flist-api/with-ticket.js";
import { makeTestDb, type TestDb } from "./test-support/db.js";
import { CONTAINER_BOOT_MS, INTEGRATION_MS } from "./test-support/budgets.js";

vi.setConfig({ testTimeout: INTEGRATION_MS });

/** What a pg client says when the database is not where it should be. */
const INTERNAL = "connect ECONNREFUSED 10.0.0.5:5432";

let testDb: TestDb;
let app: FastifyInstance;

beforeAll(async () => {
  testDb = await makeTestDb();
  app = await buildApp({
    config: loadConfig({
      ...testDb.env,
      AUTH_SECRET: "integration-test-secret-0123456789abcdef",
    }),
    db: testDb.db,
    logger: false,
  });
  // Registered here rather than in the app: this is the shape of every
  // deliberate rethrow (identities, flist-accounts, auth) and of anything
  // pg throws under a route.
  app.get("/api/test-throws", () => {
    throw new Error(INTERNAL);
  });
}, CONTAINER_BOOT_MS);

afterAll(async () => {
  await app.close();
  await testDb.stop();
});

describe("unhandled route errors", () => {
  it("answers 500 with a fixed body, never the error's own message", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/test-throws",
    });
    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain(INTERNAL);
    expect(response.body).not.toContain("ECONNREFUSED");
    expect(response.body).not.toContain("10.0.0.5");
    expect(response.json<{ error: string }>().error).toBeTypeOf("string");
  });

  it("still passes 4xx through — those messages are about the request", async () => {
    // A zod validation refusal: the client needs to know what it got wrong.
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "not-an-email", password: "" },
    });
    expect(response.statusCode).toBe(400);
    expect(response.body.length).toBeGreaterThan(0);
  });
});

describe("upstreamStatus", () => {
  const log = { debug() {}, info() {}, warn() {}, error() {} };

  it("keeps the two arms written for the user", () => {
    expect(upstreamStatus(new AccountLockedError("amber"), log).code).toBe(409);
    expect(
      upstreamStatus(new AccountLockedError("amber"), log).error,
    ).toContain("locked");
  });

  it("logs an internal failure and answers with a fixed 502", () => {
    const logged: unknown[] = [];
    const mapped = upstreamStatus(new Error(INTERNAL), {
      ...log,
      error: (fields: object) => logged.push(fields),
    });
    expect(mapped.code).toBe(502);
    expect(mapped.error).not.toContain(INTERNAL);
    expect(mapped.error).toContain("F-List");
    // Not lost — an operator still needs to see what actually broke.
    expect(logged).toHaveLength(1);
  });
});
