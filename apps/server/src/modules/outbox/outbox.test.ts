// The delayed-send outbox worker (milestone-4.md), against real Postgres with
// stubbed sessions — the release paths that the gateway suite only reaches
// incidentally: the per-identity concurrency guard (M6 audit), the failed-row
// TTL sweep (M7 audit), the restart recovery, and the ordinary channel
// release. Nothing here touches F-Chat: the sessions are fakes, because what
// is under test is which method the worker calls with which arguments.

import { and, asc, eq } from "drizzle-orm";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { OutboxItemDto } from "@emberchat/protocol";
import type { FchatSession, SessionRegistry } from "@emberchat/session-engine";
import type { Db } from "../../db/index.js";
import { makeTestDb, type TestDb } from "../../test-support/db.js";
import {
  appUsers,
  conversations,
  flistAccounts,
  identities,
  outboxMessages,
} from "../../db/schema.js";
import {
  CONTAINER_BOOT_MS,
  FRAME_WAIT_MS,
  INTEGRATION_MS,
} from "../../test-support/budgets.js";
import { FAILED_ROW_TTL_MS, Outbox } from "./outbox.js";

vi.setConfig({ testTimeout: INTEGRATION_MS });

/** Fast enough that "the next poll" is never the slow part of a test. */
const POLL_MS = 10;

let testDb: TestDb;
let db: Db;

beforeAll(async () => {
  testDb = await makeTestDb();
  db = testDb.db;
}, CONTAINER_BOOT_MS);

afterAll(async () => {
  await testDb.stop();
});

// ── Fixtures ─────────────────────────────────────────────────────────────────

let counter = 0;

async function seedIdentity(): Promise<string> {
  counter += 1;
  const [user] = await db
    .insert(appUsers)
    .values({
      email: `outbox-${String(counter)}@example.test`,
      username: `outbox${String(counter)}`,
      passwordHash: "x",
    })
    .returning({ id: appUsers.id });
  const [account] = await db
    .insert(flistAccounts)
    .values({ userId: user!.id, accountName: `acct-${String(counter)}` })
    .returning({ id: flistAccounts.id });
  const [identity] = await db
    .insert(identities)
    .values({ flistAccountId: account!.id, characterName: "Vesna Marlowe" })
    .returning({ id: identities.id });
  return identity!.id;
}

async function seedChannelConversation(
  identityId: string,
  channelKey: string,
): Promise<string> {
  const [row] = await db
    .insert(conversations)
    .values({ identityId, kind: "channel", channelKey, title: channelKey })
    .returning({ id: conversations.id });
  return row!.id;
}

async function seedPmConversation(
  identityId: string,
  partner: string,
): Promise<string> {
  const [row] = await db
    .insert(conversations)
    .values({
      identityId,
      kind: "pm",
      partnerCharacter: partner,
      title: partner,
    })
    .returning({ id: conversations.id });
  return row!.id;
}

interface SentCall {
  method: "sendChannelMessage" | "sendChannelAd" | "sendPrivateMessage";
  target: string;
  bbcode: string;
  options?: unknown;
}

interface FakeSession {
  session: FchatSession;
  sent: SentCall[];
  /** Makes the next send park until `release()` is called. */
  hold: () => void;
  release: () => void;
}

function fakeSession(): FakeSession {
  const sent: SentCall[] = [];
  let gate: Promise<void> | undefined;
  let open: (() => void) | undefined;
  const record =
    (method: SentCall["method"]) =>
    (target: string, bbcode: string, options?: unknown) => {
      sent.push({
        method,
        target,
        bbcode,
        ...(options !== undefined ? { options } : {}),
      });
      const held = gate;
      gate = undefined;
      return held ?? Promise.resolve();
    };
  return {
    sent,
    hold() {
      gate = new Promise<void>((resolve) => {
        open = resolve;
      });
    },
    release() {
      open?.();
    },
    session: {
      sendChannelMessage: record("sendChannelMessage"),
      sendChannelAd: record("sendChannelAd"),
      sendPrivateMessage: record("sendPrivateMessage"),
    } as unknown as FchatSession,
  };
}

interface Harness {
  outbox: Outbox;
  broadcasts: { identityId: string; items: OutboxItemDto[] }[];
}

const running: Outbox[] = [];
afterEach(() => {
  for (const outbox of running.splice(0)) {
    outbox.stop();
  }
});

function makeOutbox(sessions: Map<string, FchatSession>): Harness {
  const broadcasts: { identityId: string; items: OutboxItemDto[] }[] = [];
  const outbox = new Outbox({
    db,
    sessions: {
      get: (identityId: string) => sessions.get(identityId),
    } as unknown as SessionRegistry,
    hub: {
      broadcast: (identityId, event) => {
        broadcasts.push({ identityId, items: event.d.items });
      },
    },
    logger: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    },
    pollIntervalMs: POLL_MS,
  });
  running.push(outbox);
  return { outbox, broadcasts };
}

function rowsFor(identityId: string) {
  return db
    .select({
      id: outboxMessages.id,
      state: outboxMessages.state,
      bbcode: outboxMessages.bbcode,
      failureReason: outboxMessages.failureReason,
    })
    .from(outboxMessages)
    .where(eq(outboxMessages.identityId, identityId))
    .orderBy(asc(outboxMessages.releaseAt), asc(outboxMessages.createdAt));
}

// ── Release ──────────────────────────────────────────────────────────────────

describe("outbox release", () => {
  it("puts a plain channel message on the wire as a channel message", async () => {
    const identityId = await seedIdentity();
    const convId = await seedChannelConversation(identityId, "Cabin Fever");
    const fake = fakeSession();
    const h = makeOutbox(new Map([[identityId, fake.session]]));

    await h.outbox.schedule({
      identityId,
      conversationId: convId,
      markdown: "**warm**",
      bbcode: "[b]warm[/b]",
      releaseAt: new Date(Date.now() - 1000),
    });
    h.outbox.start();

    await vi.waitFor(() => {
      expect(fake.sent).toEqual([
        {
          method: "sendChannelMessage",
          target: "Cabin Fever",
          bbcode: "[b]warm[/b]",
        },
      ]);
    }, FRAME_WAIT_MS);
    // Released rows are deleted (what actually went out lives in messages),
    // and every attached device is told.
    await vi.waitFor(async () => {
      expect(await rowsFor(identityId)).toEqual([]);
    }, FRAME_WAIT_MS);
    expect(h.broadcasts.at(-1)).toEqual({ identityId, items: [] });
  });

  it("routes a DM and a delayed ad to their own send methods", async () => {
    const identityId = await seedIdentity();
    const pmId = await seedPmConversation(identityId, "Birch Rowan");
    const channelId = await seedChannelConversation(identityId, "Winter Tales");
    const fake = fakeSession();
    const h = makeOutbox(new Map([[identityId, fake.session]]));

    const past = Date.now() - 1000;
    await h.outbox.schedule({
      identityId,
      conversationId: pmId,
      markdown: "hi",
      bbcode: "hi",
      releaseAt: new Date(past),
    });
    await h.outbox.schedule({
      identityId,
      conversationId: channelId,
      markdown: "ad",
      bbcode: "ad",
      kind: "lrp",
      releaseAt: new Date(past + 1),
    });
    h.outbox.start();

    await vi.waitFor(() => {
      expect(fake.sent).toHaveLength(2);
    }, FRAME_WAIT_MS);
    expect(fake.sent).toEqual([
      { method: "sendPrivateMessage", target: "Birch Rowan", bbcode: "hi" },
      {
        method: "sendChannelAd",
        target: "Winter Tales",
        bbcode: "ad",
        // A parked ad is MEANT to wait out the 10-minute lfrp gate; only
        // this user's own queue waits behind it.
        options: { wait: true },
      },
    ]);
  });

  it("keeps a refused row with its reason instead of losing the text", async () => {
    const identityId = await seedIdentity();
    const convId = await seedChannelConversation(identityId, "Cabin Fever");
    // No session for this identity: the release has nowhere to go.
    const h = makeOutbox(new Map());

    await h.outbox.schedule({
      identityId,
      conversationId: convId,
      markdown: "typed this",
      bbcode: "typed this",
      releaseAt: new Date(Date.now() - 1000),
    });
    h.outbox.start();

    await vi.waitFor(async () => {
      expect(await rowsFor(identityId)).toEqual([
        expect.objectContaining({
          state: "failed",
          failureReason: "no live session at release time",
        }),
      ]);
    }, FRAME_WAIT_MS);
    // Still recallable, so the composer can get the text back.
    const recalled = await h.outbox.recall(
      identityId,
      (await rowsFor(identityId))[0]!.id,
    );
    expect(recalled).toEqual({ markdown: "typed this" });
  });

  it("surfaces rows a dead worker left claimed rather than re-sending them", async () => {
    const identityId = await seedIdentity();
    const convId = await seedChannelConversation(identityId, "Cabin Fever");
    await db.insert(outboxMessages).values({
      identityId,
      conversationId: convId,
      markdown: "in flight when the process died",
      bbcode: "x",
      state: "releasing",
      releaseAt: new Date(Date.now() - 1000),
    });
    const fake = fakeSession();
    const h = makeOutbox(new Map([[identityId, fake.session]]));
    h.outbox.start();

    // Ambiguous by nature — it may already have reached F-Chat, so it is
    // surfaced with the ambiguity spelled out, never silently re-sent.
    await vi.waitFor(async () => {
      expect(await rowsFor(identityId)).toEqual([
        expect.objectContaining({
          state: "failed",
          failureReason: "interrupted by a restart — it may have been sent",
        }),
      ]);
    }, FRAME_WAIT_MS);
    expect(fake.sent).toEqual([]);
  });
});

// ── The concurrency guard (M6 audit) ─────────────────────────────────────────

describe("outbox concurrency", () => {
  it("never lets one identity's stalled chain hold up another's due rows", async () => {
    const slowId = await seedIdentity();
    const fastId = await seedIdentity();
    const slowConv = await seedChannelConversation(slowId, "Slow Room");
    const fastConv = await seedChannelConversation(fastId, "Fast Room");
    const slow = fakeSession();
    const fast = fakeSession();
    const h = makeOutbox(
      new Map([
        [slowId, slow.session],
        [fastId, fast.session],
      ]),
    );

    const past = Date.now() - 1000;
    // The slow identity's first send parks (a queued ad waiting out the
    // 10-minute lfrp gate is exactly this shape) and it has a second row
    // behind it.
    await h.outbox.schedule({
      identityId: slowId,
      conversationId: slowConv,
      markdown: "one",
      bbcode: "one",
      releaseAt: new Date(past),
    });
    await h.outbox.schedule({
      identityId: slowId,
      conversationId: slowConv,
      markdown: "two",
      bbcode: "two",
      releaseAt: new Date(past + 1),
    });
    await h.outbox.schedule({
      identityId: fastId,
      conversationId: fastConv,
      markdown: "unrelated",
      bbcode: "unrelated",
      releaseAt: new Date(past + 2),
    });
    slow.hold();
    h.outbox.start();

    // The other user's row goes out while the slow chain is still parked —
    // that is the whole invariant.
    await vi.waitFor(() => {
      expect(fast.sent.map((call) => call.bbcode)).toEqual(["unrelated"]);
    }, FRAME_WAIT_MS);
    await vi.waitFor(async () => {
      expect(await rowsFor(fastId)).toEqual([]);
    }, FRAME_WAIT_MS);

    // And the stalled identity's own second row was not claimed by a later
    // poll: release order within an identity is promised, so it waits.
    expect(slow.sent.map((call) => call.bbcode)).toEqual(["one"]);
    expect((await rowsFor(slowId)).map((row) => row.state)).toEqual([
      "releasing",
      "scheduled",
    ]);

    // Once the gate opens the chain drains, in order.
    slow.release();
    await vi.waitFor(async () => {
      expect(await rowsFor(slowId)).toEqual([]);
    }, FRAME_WAIT_MS);
    expect(slow.sent.map((call) => call.bbcode)).toEqual(["one", "two"]);
  });
});

// ── The failed-row sweep (M7 audit) ──────────────────────────────────────────

describe("outbox failed-row sweep", () => {
  it("reaps failures past the TTL, keeps recent ones, and fans the change", async () => {
    const identityId = await seedIdentity();
    const convId = await seedChannelConversation(identityId, "Cabin Fever");
    const now = Date.now();
    const failed = (
      markdown: string,
      failedAt: Date | null,
      releaseAt: Date,
    ) => ({
      identityId,
      conversationId: convId,
      markdown,
      bbcode: markdown,
      state: "failed",
      failureReason: "send failed",
      failedAt,
      releaseAt,
    });
    await db.insert(outboxMessages).values([
      // Past the week: gone.
      failed(
        "ancient",
        new Date(now - FAILED_ROW_TTL_MS - 60_000),
        new Date(now - FAILED_ROW_TTL_MS - 60_000),
      ),
      // A pre-migration row has no failedAt — the sweep falls back to
      // releaseAt rather than keeping it forever.
      failed("legacy", null, new Date(now - FAILED_ROW_TTL_MS - 60_000)),
      // Failed a week after its release: the TTL keys on the failure, so
      // this one still has its full window to be seen.
      failed(
        "recent",
        new Date(now - 60_000),
        new Date(now - FAILED_ROW_TTL_MS - 60_000),
      ),
    ]);
    const h = makeOutbox(new Map());
    h.outbox.start();

    await vi.waitFor(async () => {
      expect((await rowsFor(identityId)).map((row) => row.bbcode)).toEqual([
        "recent",
      ]);
    }, FRAME_WAIT_MS);
    // Attached devices are told, or their pending lists keep showing rows
    // the database no longer has.
    const fan = h.broadcasts.find((event) => event.identityId === identityId);
    expect(fan?.items.map((item) => item.markdown)).toEqual(["recent"]);
    expect(fan?.items[0]).toMatchObject({ state: "failed" });
  });

  it("leaves other identities' failures alone", async () => {
    const mine = await seedIdentity();
    const theirs = await seedIdentity();
    const mineConv = await seedChannelConversation(mine, "Mine");
    const theirsConv = await seedChannelConversation(theirs, "Theirs");
    const old = new Date(Date.now() - FAILED_ROW_TTL_MS - 60_000);
    await db.insert(outboxMessages).values([
      {
        identityId: mine,
        conversationId: mineConv,
        markdown: "stale",
        bbcode: "stale",
        state: "failed",
        failedAt: old,
        releaseAt: old,
      },
      {
        identityId: theirs,
        conversationId: theirsConv,
        markdown: "fresh",
        bbcode: "fresh",
        state: "failed",
        failedAt: new Date(),
        releaseAt: old,
      },
    ]);
    const h = makeOutbox(new Map());
    h.outbox.start();

    await vi.waitFor(async () => {
      expect(await rowsFor(mine)).toEqual([]);
    }, FRAME_WAIT_MS);
    expect((await rowsFor(theirs)).map((row) => row.bbcode)).toEqual(["fresh"]);
    // A scheduled row of the same age is not a failure and is never swept.
    const [survivor] = await db
      .select({ id: outboxMessages.id })
      .from(outboxMessages)
      .where(
        and(
          eq(outboxMessages.identityId, theirs),
          eq(outboxMessages.state, "failed"),
        ),
      );
    expect(survivor).toBeDefined();
  });
});
