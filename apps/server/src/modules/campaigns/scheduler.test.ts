// Campaign scheduler (M11 step 3): deterministic clock-controlled tests
// against real Postgres (testcontainers) with a stubbed session and hub —
// rotation is NEVER exercised against live F-Chat (policy). The injected
// `now`/`random` make every jittered timeline exact.

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { eq } from "drizzle-orm";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CampaignDto } from "@emberchat/protocol";
import { createDb, type Db } from "../../db/index.js";
import {
  ads,
  appUsers,
  campaigns,
  flistAccounts,
  identities,
} from "../../db/schema.js";
import {
  AdCooldownError,
  type FchatSession,
} from "../session-engine/fchat-session.js";
import { CampaignError, CampaignScheduler } from "./scheduler.js";

const MIGRATIONS = fileURLToPath(new URL("../../../drizzle", import.meta.url));

vi.setConfig({ testTimeout: 15_000 });

let container: StartedPostgreSqlContainer;
let db: Db;
let pool: { end: () => Promise<void> };

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:18-alpine").start();
  ({ db, pool } = createDb(container.getConnectionUri()));
  await migrate(db, { migrationsFolder: MIGRATIONS });
}, 180_000);

afterAll(async () => {
  await pool.end();
  await container.stop();
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
  const controls: FakeSessionControls = {
    sent,
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
      status: "online",
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
  const broadcasts: (CampaignDto | null)[] = [];
  const scheduler = new CampaignScheduler({
    db,
    sessions: { get: () => controls.session },
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
    await revived.tickOnce();
    expect(h.controls.sent).toHaveLength(1);
    h.clock.value += 1_000;
    await revived.tickOnce();
    expect(h.controls.sent).toHaveLength(2);

    const [row] = await db
      .select({ channels: campaigns.channels })
      .from(campaigns)
      .where(eq(campaigns.identityId, h.identityId));
    expect(row!.channels[0]!.posts).toBe(2);
  });
});
