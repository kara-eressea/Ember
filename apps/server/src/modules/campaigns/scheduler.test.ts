// Campaign scheduler (M11 step 3): deterministic clock-controlled tests
// against real Postgres (testcontainers) with a stubbed session and hub —
// rotation is NEVER exercised against live F-Chat (policy). The injected
// `now`/`random` make every jittered timeline exact.

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CampaignDto } from "@emberchat/protocol";
import type { Db } from "../../db/index.js";
import { makeTestDb, type TestDb } from "../../test-support/db.js";
import {
  ads,
  appUsers,
  campaigns,
  flistAccounts,
  identities,
} from "../../db/schema.js";
import { FchatErrorCode } from "@emberchat/fchat-protocol";
import {
  AdCooldownError,
  type FchatSession,
  SessionNotOnlineError,
} from "@emberchat/session-engine";
import { CampaignError, CampaignScheduler } from "./scheduler.js";
import {
  CONTAINER_BOOT_MS,
  INTEGRATION_MS,
} from "../../test-support/budgets.js";

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

let counter = 0;
async function seedIdentity(): Promise<{ identityId: string; userId: string }> {
  counter += 1;
  const [user] = await db
    .insert(appUsers)
    .values({
      email: `campaign-${String(counter)}@example.test`,
      username: `campaign${String(counter)}`,
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
  return { identityId: identity!.id, userId: user!.id };
}

async function seedAds(
  identityId: string,
  rows: { content: string; tags: string[]; disabled?: boolean }[],
): Promise<void> {
  await db.insert(ads).values(
    rows.map((row, index) => ({
      identityId,
      content: row.content,
      tags: row.tags,
      disabled: row.disabled ?? false,
      sortOrder: index,
    })),
  );
}

interface FakeSessionControls {
  session: FchatSession;
  sent: { channel: string; message: string }[];
  setChannels: (
    channels: { key: string; mode?: string; description?: string }[],
  ) => void;
  throwNext: (error: Error) => void;
  /** Flips `session.status`, which gates every posting tick. */
  setStatus: (status: string) => void;
  /** Fires a frame on the session's bus, as the live socket would. */
  emit: (kind: string, payload: unknown) => void;
}

function fakeSession(
  channels: { key: string; mode?: string; description?: string }[],
): FakeSessionControls {
  const sent: { channel: string; message: string }[] = [];
  const state = {
    channels: new Map<
      string,
      { key: string; title: string; mode: string; description: string }
    >(),
    // Small flood so the tests' base interval is the binding floor.
    vars: { lfrp_flood: 30, lfrp_max: 50_000 },
  };
  const listeners = new Map<string, ((payload: unknown) => void)[]>();
  let pendingError: Error | undefined;
  let status = "online";
  const controls: FakeSessionControls = {
    sent,
    setStatus(next) {
      status = next;
    },
    emit(kind, payload) {
      for (const listener of listeners.get(kind) ?? []) {
        listener(payload);
      }
    },
    setChannels(next) {
      state.channels.clear();
      for (const channel of next) {
        state.channels.set(channel.key, {
          key: channel.key,
          title: channel.key,
          mode: channel.mode ?? "both",
          description: channel.description ?? "",
        });
      }
    },
    throwNext(error) {
      pendingError = error;
    },
    session: {
      get status() {
        return status;
      },
      state,
      events: {
        on(kind: string, listener: (payload: unknown) => void) {
          const list = listeners.get(kind) ?? [];
          list.push(listener);
          listeners.set(kind, list);
          return () => {};
        },
        emit(kind: string, payload: unknown) {
          for (const listener of listeners.get(kind) ?? []) {
            listener(payload);
          }
        },
      },
      sendChannelAd(channel: string, message: string) {
        if (pendingError) {
          const error = pendingError;
          pendingError = undefined;
          return Promise.reject(error);
        }
        sent.push({ channel, message });
        return Promise.resolve();
      },
      adWaitMs() {
        return 600_000;
      },
    } as unknown as FchatSession,
  };
  controls.setChannels(channels);
  return controls;
}

interface Harness {
  scheduler: CampaignScheduler;
  clock: { value: number };
  broadcasts: (CampaignDto | null)[];
  attached: { value: boolean };
  /** Whether the registry still hands out a session for this identity. */
  connected: { value: boolean };
  controls: FakeSessionControls;
  identityId: string;
  userId: string;
}

async function harness(
  channels: { key: string; mode?: string; description?: string }[],
  adRows: { content: string; tags: string[]; disabled?: boolean }[],
): Promise<Harness> {
  const { identityId, userId } = await seedIdentity();
  await seedAds(identityId, adRows);
  const controls = fakeSession(channels);
  const clock = { value: 1_000_000 };
  const attached = { value: true };
  const connected = { value: true };
  const broadcasts: (CampaignDto | null)[] = [];
  const scheduler = new CampaignScheduler({
    db,
    sessions: { get: () => (connected.value ? controls.session : undefined) },
    hub: {
      hasSubscribers: () => attached.value,
      broadcast: (_id, event) => {
        broadcasts.push(event.d.campaign);
      },
    },
    // Deterministic timeline: zero jitter, zero start stagger beyond the
    // spacing beat, tiny spacing.
    spacingMs: 1_000,
    startJitterMs: 0,
    intervalJitterMs: 0,
    baseIntervalMs: 60_000,
    random: () => 0,
    now: () => clock.value,
  });
  return {
    scheduler,
    clock,
    broadcasts,
    attached,
    connected,
    controls,
    identityId,
    userId,
  };
}

describe("campaign scheduler", () => {
  it("rotates the tag set in library order across channels on schedule", async () => {
    const h = await harness(
      [{ key: "Cabin Fever" }, { key: "Winter Tales" }],
      [
        { content: "ad one", tags: ["winter"] },
        { content: "ad two", tags: ["winter"] },
        { content: "skipped", tags: ["other"] },
        { content: "disabled", tags: ["winter"], disabled: true },
      ],
    );
    await h.scheduler.startCampaign(h.identityId, h.userId, {
      tags: ["winter"],
      channels: ["Cabin Fever", "Winter Tales"],
    });
    // Nothing fires before the start stagger (spacing beat).
    await h.scheduler.tickOnce();
    expect(h.controls.sent).toHaveLength(0);

    h.clock.value += 1_000;
    await h.scheduler.tickOnce();
    expect(h.controls.sent).toHaveLength(1);
    expect(h.controls.sent[0]).toEqual({
      channel: "Cabin Fever",
      message: "ad one",
    });

    // Second channel waits out the app-wide spacing, then posts the NEXT
    // ad in the cycle — channels share the identity's cycle per channel.
    await h.scheduler.tickOnce();
    expect(h.controls.sent).toHaveLength(1);
    h.clock.value += 1_000;
    await h.scheduler.tickOnce();
    expect(h.controls.sent).toHaveLength(2);
    expect(h.controls.sent[1]!.channel).toBe("Winter Tales");
    expect(h.controls.sent[1]!.message).toBe("ad one");

    // The first channel's next post honors the base interval and cycles
    // to ad two (its own cycle position).
    h.clock.value += 59_000;
    await h.scheduler.tickOnce();
    h.clock.value += 1_000;
    await h.scheduler.tickOnce();
    const cabin = h.controls.sent.filter((s) => s.channel === "Cabin Fever");
    expect(cabin.map((s) => s.message)).toEqual(["ad one", "ad two"]);
  });

  it("raises a channel's floor to its [ads: N min] request", async () => {
    const h = await harness(
      [{ key: "Slow Room", description: "please [ads: 5 min]" }],
      [{ content: "ad", tags: ["t"] }],
    );
    // base 60s, request 5min → effective 5min.
    await h.scheduler.startCampaign(h.identityId, h.userId, {
      tags: ["t"],
      channels: ["Slow Room"],
    });
    h.clock.value += 1_000;
    await h.scheduler.tickOnce();
    expect(h.controls.sent).toHaveLength(1);
    const dto = h.scheduler.dtoFor(h.identityId)!;
    const next = dto.channels[0]!.nextAt!;
    expect(next - h.clock.value).toBe(5 * 60_000);
  });

  it("pauses a refused channel visibly and auto-resumes when the window reopens", async () => {
    const h = await harness(
      [{ key: "Busy Room" }],
      [{ content: "ad", tags: ["t"] }],
    );
    await h.scheduler.startCampaign(h.identityId, h.userId, {
      tags: ["t"],
      channels: ["Busy Room"],
    });
    h.controls.throwNext(new AdCooldownError(600, 600_000));
    h.clock.value += 1_000;
    await h.scheduler.tickOnce();
    expect(h.controls.sent).toHaveLength(0);
    const refusedDto = h.scheduler.dtoFor(h.identityId)!;
    expect(refusedDto.channels[0]!.state).toBe("refused");
    expect(refusedDto.channels[0]!.retryAt).toBe(h.clock.value + 600_000);

    // The window reopens → active again, and the next tick posts.
    h.clock.value += 600_000;
    await h.scheduler.tickOnce();
    const resumedDto = h.scheduler.dtoFor(h.identityId)!;
    expect(resumedDto.channels[0]!.state).toBe("active");
    h.clock.value += 1_000;
    await h.scheduler.tickOnce();
    expect(h.controls.sent).toHaveLength(1);
  });

  it("stops a channel permanently when the character is removed from it", async () => {
    const h = await harness(
      [{ key: "Aurora Den" }, { key: "Frozen North" }],
      [{ content: "ad", tags: ["t"] }],
    );
    await h.scheduler.startCampaign(h.identityId, h.userId, {
      tags: ["t"],
      channels: ["Aurora Den", "Frozen North"],
    });
    h.controls.setChannels([{ key: "Frozen North" }]);
    // One absent tick is NOT a removal — reconnect rejoins take a while;
    // only continuous absence past the grace window is terminal.
    await h.scheduler.tickOnce();
    expect(
      h.scheduler
        .dtoFor(h.identityId)!
        .channels.find((c) => c.key === "Aurora Den")!.state,
    ).not.toBe("removed");
    h.clock.value += 30_000;
    await h.scheduler.tickOnce();
    const dto = h.scheduler.dtoFor(h.identityId)!;
    const aurora = dto.channels.find((c) => c.key === "Aurora Den")!;
    expect(aurora.state).toBe("removed");

    // Renew revives the campaign but never a removed channel.
    await h.scheduler.renewCampaign(h.identityId);
    expect(
      h.scheduler
        .dtoFor(h.identityId)!
        .channels.find((c) => c.key === "Aurora Den")!.state,
    ).toBe("removed");
  });

  it("holds the whole campaign while detached and while stopped, and expires exactly once", async () => {
    const h = await harness(
      [{ key: "Cabin Fever" }],
      [{ content: "ad", tags: ["t"] }],
    );
    await h.scheduler.startCampaign(h.identityId, h.userId, {
      tags: ["t"],
      channels: ["Cabin Fever"],
    });

    h.attached.value = false;
    h.clock.value += 5_000;
    await h.scheduler.tickOnce();
    expect(h.controls.sent).toHaveLength(0);
    const dto = h.scheduler.dtoFor(h.identityId)!;
    expect(dto.attached).toBe(false);
    expect(dto.channels[0]!.state).toBe("waiting");

    // Re-attach: posting resumes.
    h.attached.value = true;
    await h.scheduler.tickOnce();
    expect(h.controls.sent).toHaveLength(1);

    // Kill switch: nothing more goes out.
    await h.scheduler.stopCampaign(h.identityId);
    h.clock.value += 120_000;
    await h.scheduler.tickOnce();
    expect(h.controls.sent).toHaveLength(1);

    // Renew restarts; expiry then ends it and never double-fires.
    await h.scheduler.renewCampaign(h.identityId);
    h.clock.value += 60 * 60_000 + 1;
    await h.scheduler.tickOnce();
    expect(h.controls.sent).toHaveLength(1);
    const broadcastsAtExpiry = h.broadcasts.length;
    await h.scheduler.tickOnce();
    expect(h.broadcasts.length).toBe(broadcastsAtExpiry);
  });

  it("refuses bad starts in plain language and demands explicit replacement", async () => {
    const h = await harness(
      [{ key: "Cabin Fever" }, { key: "Chat Only", mode: "chat" }],
      [{ content: "ad", tags: ["t"] }],
    );
    await expect(
      h.scheduler.startCampaign(h.identityId, h.userId, {
        tags: ["untagged"],
        channels: ["Cabin Fever"],
      }),
    ).rejects.toThrow(CampaignError);
    await expect(
      h.scheduler.startCampaign(h.identityId, h.userId, {
        tags: ["t"],
        channels: ["Chat Only"],
      }),
    ).rejects.toThrow("doesn't allow ads");

    await h.scheduler.startCampaign(h.identityId, h.userId, {
      tags: ["t"],
      channels: ["Cabin Fever"],
    });
    await expect(
      h.scheduler.startCampaign(h.identityId, h.userId, {
        tags: ["t"],
        channels: ["Cabin Fever"],
      }),
    ).rejects.toThrow("already running");
    await h.scheduler.startCampaign(h.identityId, h.userId, {
      tags: ["t"],
      channels: ["Cabin Fever"],
      replace: true,
    });
  });

  it("persists across restarts without burst-posting", async () => {
    const h = await harness(
      [{ key: "Cabin Fever" }],
      [{ content: "ad", tags: ["t"] }],
    );
    await h.scheduler.startCampaign(h.identityId, h.userId, {
      tags: ["t"],
      channels: ["Cabin Fever"],
    });
    h.clock.value += 1_000;
    await h.scheduler.tickOnce();
    expect(h.controls.sent).toHaveLength(1);

    // A second scheduler (fresh process) resumes the same campaign from
    // the row: posts survive, and the timeline restarts with a stagger
    // instead of firing immediately.
    const revived = new CampaignScheduler({
      db,
      // The shared test DB holds every prior test's campaign row; only
      // this harness's identity gets a live session.
      sessions: {
        get: (id: string) =>
          id === h.identityId ? h.controls.session : undefined,
      },
      hub: { hasSubscribers: () => true, broadcast: () => {} },
      spacingMs: 1_000,
      startJitterMs: 0,
      intervalJitterMs: 0,
      baseIntervalMs: 60_000,
      random: () => 0,
      now: () => h.clock.value,
    });
    await revived.start();
    revived.stop();
    const dto = revived.dtoFor(h.identityId)!;
    expect(dto.channels[0]!.posts).toBe(1);
    // The persisted lastAt floors the rebuilt timeline: nothing may post
    // under the per-channel floor just because the process restarted.
    h.clock.value += 1_000;
    await revived.tickOnce();
    expect(h.controls.sent).toHaveLength(1);
    h.clock.value += 60_000;
    await revived.tickOnce();
    expect(h.controls.sent).toHaveLength(2);

    const [row] = await db
      .select({ channels: campaigns.channels })
      .from(campaigns)
      .where(eq(campaigns.identityId, h.identityId));
    expect(row!.channels[0]!.posts).toBe(2);
  });
});

// Every way a campaign post can go wrong (#561). The success path is covered
// above and end-to-end in apps/web/e2e/m11.spec.ts; these are the guards that
// stand between a running rotation and posting ads F-Chat is already refusing
// — the exact thing the developer policy forbids.
describe("campaign scheduler refusals", () => {
  it("attributes a live ERR 56 to the ad it just posted and pauses that channel", async () => {
    const h = await harness(
      [{ key: "Busy Room" }],
      [{ content: "ad", tags: ["t"] }],
    );
    await h.scheduler.startCampaign(h.identityId, h.userId, {
      tags: ["t"],
      channels: ["Busy Room"],
    });
    h.clock.value += 1_000;
    await h.scheduler.tickOnce();
    expect(h.controls.sent).toHaveLength(1);
    const broadcastsBefore = h.broadcasts.length;

    // Another client of the same character posted into this channel's window
    // and F-Chat refused ours. LRP carries no correlation on the wire, so the
    // ERR is attributed to our most recent campaign post.
    h.controls.emit("command", {
      cmd: "ERR",
      payload: {
        number: FchatErrorCode.AdFlood,
        message: "You must wait longer before posting another ad.",
      },
    });

    const dto = h.scheduler.dtoFor(h.identityId)!;
    expect(dto.channels[0]!.state).toBe("refused");
    // The live lfrp_flood VAR decides how long the pause lasts — read from
    // the server at refusal time, never a hardcoded window.
    expect(dto.channels[0]!.retryAt).toBe(h.clock.value + 30_000);
    // Attached devices see the pause, not a silently stalled channel.
    expect(h.broadcasts.length).toBeGreaterThan(broadcastsBefore);
    expect(h.broadcasts.at(-1)!.channels[0]!.state).toBe("refused");

    // And nothing else goes out while it is refused.
    await h.scheduler.tickOnce();
    expect(h.controls.sent).toHaveLength(1);

    // The pause survives a restart: it is written through to the row.
    await vi.waitFor(async () => {
      const [row] = await db
        .select({ channels: campaigns.channels })
        .from(campaigns)
        .where(eq(campaigns.identityId, h.identityId));
      expect(row!.channels[0]!.state).toBe("refused");
    });
  });

  it("ignores an ERR 56 that cannot belong to a campaign post", async () => {
    const h = await harness(
      [{ key: "Busy Room" }],
      [{ content: "ad", tags: ["t"] }],
    );
    await h.scheduler.startCampaign(h.identityId, h.userId, {
      tags: ["t"],
      channels: ["Busy Room"],
    });

    // Before any campaign post there is nothing to attribute to: a refusal
    // earned by the user's own manual ad must not pause the rotation.
    h.controls.emit("command", {
      cmd: "ERR",
      payload: { number: FchatErrorCode.AdFlood, message: "too soon" },
    });
    expect(h.scheduler.dtoFor(h.identityId)!.channels[0]!.state).toBe("active");

    h.clock.value += 1_000;
    await h.scheduler.tickOnce();
    expect(h.controls.sent).toHaveLength(1);

    // A minute later the ERR is far outside the attribution window, and a
    // non-ad ERR never counts at all.
    h.clock.value += 60_000;
    h.controls.emit("command", {
      cmd: "ERR",
      payload: { number: FchatErrorCode.AdFlood, message: "too soon" },
    });
    h.controls.emit("command", {
      cmd: "ERR",
      payload: { number: FchatErrorCode.MessageTooLong, message: "too long" },
    });
    expect(h.scheduler.dtoFor(h.identityId)!.channels[0]!.state).toBe("active");
  });

  it("never dips under the live per-channel floor, whatever the timeline says", async () => {
    const h = await harness(
      [{ key: "Cabin Fever" }],
      [{ content: "ad", tags: ["t"] }],
    );
    await h.scheduler.startCampaign(h.identityId, h.userId, {
      tags: ["t"],
      channels: ["Cabin Fever"],
    });
    h.clock.value += 1_000;
    await h.scheduler.tickOnce();
    expect(h.controls.sent).toHaveLength(1);
    const postedAt = h.clock.value;

    // Renew rebuilds the timeline with a fresh start stagger — which, two
    // seconds after a post, would come due long before the channel's floor.
    // The post-time guard is what makes that safe (audit HIGH).
    h.clock.value += 2_000;
    await h.scheduler.renewCampaign(h.identityId);
    h.clock.value += 1_000;
    await h.scheduler.tickOnce();

    expect(h.controls.sent).toHaveLength(1);
    const dto = h.scheduler.dtoFor(h.identityId)!;
    expect(dto.channels[0]!.nextAt).toBe(postedAt + 60_000);
    // …and once the floor has actually passed, it posts again.
    h.clock.value = postedAt + 60_000;
    await h.scheduler.tickOnce();
    expect(h.controls.sent).toHaveLength(2);
  });

  it("leaves a channel untouched when the socket drops mid-tick", async () => {
    const h = await harness(
      [{ key: "Cabin Fever" }],
      [{ content: "ad", tags: ["t"] }],
    );
    await h.scheduler.startCampaign(h.identityId, h.userId, {
      tags: ["t"],
      channels: ["Cabin Fever"],
    });
    const dueAt = h.scheduler.dtoFor(h.identityId)!.channels[0]!.nextAt;

    h.controls.throwNext(new SessionNotOnlineError("connecting"));
    h.clock.value += 1_000;
    await h.scheduler.tickOnce();

    // No post, no state change, no rescheduling: the next tick re-evaluates
    // from exactly where this one started.
    expect(h.controls.sent).toHaveLength(0);
    const dto = h.scheduler.dtoFor(h.identityId)!;
    expect(dto.channels[0]!.state).toBe("active");
    expect(dto.channels[0]!.nextAt).toBe(dueAt);
    expect(dto.channels[0]!.posts).toBe(0);

    await h.scheduler.tickOnce();
    expect(h.controls.sent).toHaveLength(1);
  });

  it("skips an ad it cannot send, advances the cycle, and keeps the channel alive", async () => {
    const h = await harness(
      [{ key: "Cabin Fever" }],
      [
        { content: "ad one", tags: ["t"] },
        { content: "ad two", tags: ["t"] },
      ],
    );
    await h.scheduler.startCampaign(h.identityId, h.userId, {
      tags: ["t"],
      channels: ["Cabin Fever"],
    });

    // Anything that is neither a cooldown nor a dropped socket — an ad that
    // translates over the byte limit, an unexpected refusal. Retrying the
    // same ad forever would be the wrong answer.
    h.controls.throwNext(new Error("Message exceeds the server's byte limit"));
    h.clock.value += 1_000;
    await h.scheduler.tickOnce();
    expect(h.controls.sent).toHaveLength(0);
    const dto = h.scheduler.dtoFor(h.identityId)!;
    expect(dto.channels[0]!.state).toBe("active");
    expect(dto.channels[0]!.nextAt).toBe(h.clock.value + 60_000);

    // The next slot posts the NEXT ad in the rotation, not the one that failed.
    h.clock.value += 60_000;
    await h.scheduler.tickOnce();
    expect(h.controls.sent.map((s) => s.message)).toEqual(["ad two"]);
  });

  it("waits out the interval when the library empties under a running campaign", async () => {
    const h = await harness(
      [{ key: "Cabin Fever" }],
      [{ content: "ad", tags: ["t"] }],
    );
    await h.scheduler.startCampaign(h.identityId, h.userId, {
      tags: ["t"],
      channels: ["Cabin Fever"],
    });
    // The user disabled the only ad the campaign's tags select.
    await db
      .update(ads)
      .set({ disabled: true })
      .where(eq(ads.identityId, h.identityId));

    h.clock.value += 1_000;
    await h.scheduler.tickOnce();
    expect(h.controls.sent).toHaveLength(0);
    const dto = h.scheduler.dtoFor(h.identityId)!;
    // Rescheduled rather than spun on every 5-second tick.
    expect(dto.channels[0]!.state).toBe("active");
    expect(dto.channels[0]!.nextAt).toBe(h.clock.value + 60_000);

    // Re-enabling it resumes the rotation with no further intervention.
    await db
      .update(ads)
      .set({ disabled: false })
      .where(eq(ads.identityId, h.identityId));
    h.clock.value += 60_000;
    await h.scheduler.tickOnce();
    expect(h.controls.sent).toHaveLength(1);
  });

  it("refuses to start against a character that isn't connected", async () => {
    const h = await harness(
      [{ key: "Cabin Fever" }],
      [{ content: "ad", tags: ["t"] }],
    );
    h.connected.value = false;
    await expect(
      h.scheduler.startCampaign(h.identityId, h.userId, {
        tags: ["t"],
        channels: ["Cabin Fever"],
      }),
    ).rejects.toThrow("This character isn't connected right now");

    // A session that exists but has not finished identifying is no better.
    h.connected.value = true;
    h.controls.setStatus("connecting");
    await expect(
      h.scheduler.startCampaign(h.identityId, h.userId, {
        tags: ["t"],
        channels: ["Cabin Fever"],
      }),
    ).rejects.toThrow("This character isn't connected right now");
  });

  it("refuses to start on a channel the character has already left", async () => {
    const h = await harness(
      [{ key: "Cabin Fever" }],
      [{ content: "ad", tags: ["t"] }],
    );
    await expect(
      h.scheduler.startCampaign(h.identityId, h.userId, {
        tags: ["t"],
        channels: ["Cabin Fever", "Ghost Room"],
      }),
    ).rejects.toThrow("You're not in one of those channels any more");
    expect(h.scheduler.dtoFor(h.identityId)).toBeNull();
  });

  it("refuses stop, renew and drop for a character with no campaign", async () => {
    const h = await harness(
      [{ key: "Cabin Fever" }],
      [{ content: "ad", tags: ["t"] }],
    );
    for (const call of [
      () => h.scheduler.stopCampaign(h.identityId),
      () => h.scheduler.renewCampaign(h.identityId),
      () => h.scheduler.dropChannel(h.identityId, "Cabin Fever"),
    ]) {
      await expect(call()).rejects.toThrow(
        "There's no campaign for this character",
      );
    }
  });
});

describe("dropChannel", () => {
  it("removes exactly the named channel, case-insensitively", async () => {
    const h = await harness(
      [{ key: "Cabin Fever" }, { key: "Winter Tales" }],
      [{ content: "ad", tags: ["t"] }],
    );
    await h.scheduler.startCampaign(h.identityId, h.userId, {
      tags: ["t"],
      channels: ["Cabin Fever", "Winter Tales"],
    });
    await h.scheduler.dropChannel(h.identityId, "cabin fever");
    const dto = h.scheduler.dtoFor(h.identityId)!;
    expect(dto.channels.map((c) => c.key)).toEqual(["Winter Tales"]);
    await expect(
      h.scheduler.dropChannel(h.identityId, "Cabin Fever"),
    ).rejects.toThrow(CampaignError);
  });
});
