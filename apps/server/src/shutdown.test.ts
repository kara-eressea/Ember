// Graceful shutdown (review round #558). Every write path in the server is a
// fire-and-forget queue — the history sink, the notification store, the
// seen-members store, the channel directory — and main.ts closes the pool the
// instant `app.close()` resolves. So `app.close()` has to mean "the queues are
// empty", not just "the timers are cleared": a message dropped there is lost
// from history AND from the gateway fan-out, which is post-persistence.

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import type { Db } from "./db/index.js";
import { flistAccounts, identities, notifications } from "./db/schema.js";
import { makeTestDb, type TestDb } from "./test-support/db.js";
import { CONTAINER_BOOT_MS, INTEGRATION_MS } from "./test-support/budgets.js";

vi.setConfig({ testTimeout: INTEGRATION_MS });

let testDb: TestDb;
let db: Db;

beforeAll(async () => {
  testDb = await makeTestDb();
  db = testDb.db;
}, CONTAINER_BOOT_MS);

afterAll(async () => {
  await testDb.stop();
});

it("drains queued writes before close resolves", async () => {
  const app = await buildApp({
    config: loadConfig({
      ...testDb.env,
      AUTH_SECRET: "integration-test-secret-0123456789abcdef",
      REGISTRATION_ENABLED: "true",
    }),
    db,
    logger: false,
  });
  const register = await app.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: {
      email: "shutdown@example.test",
      username: "shutdown",
      password: "hunter2hunter2",
    },
  });
  expect(register.statusCode).toBe(201);
  const userId = register.json<{ user: { id: string } }>().user.id;
  const [account] = await db
    .insert(flistAccounts)
    .values({ userId, accountName: "shutdown@example.test" })
    .returning({ id: flistAccounts.id });
  const [identity] = await db
    .insert(identities)
    .values({ flistAccountId: account!.id, characterName: "Shutdown Test" })
    .returning({ id: identities.id });
  const identityId = identity!.id;

  // Exactly how app.ts records a website event off the session's command
  // handler: nothing awaits these, so at close time they are a backlog on
  // the store's per-identity chain.
  const queued = 25;
  for (let i = 0; i < queued; i += 1) {
    void app.notifications.recordRtb(
      identityId,
      "note",
      "Someone Else",
      `note ${String(i)}`,
    );
  }

  await app.close();

  const rows = await db
    .select({ id: notifications.id })
    .from(notifications)
    .where(eq(notifications.identityId, identityId));
  expect(rows).toHaveLength(queued);
});
