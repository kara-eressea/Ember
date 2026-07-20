// Ad-rotation campaigns (M11 step 3, design/milestone-11-discovery-extras.md
// §1): one campaign per character — a tag set whose enabled ads cycle in
// library order across chosen channels, bounded by a 1-hour renewable
// expiry. Policy posture (all figures settled with the user against the
// Horizon survey, never client-tunable):
//
// - 12-minute hard floor per channel, raised by the channel's `[ads: N min]`
//   description request; jitter on top so posting never looks metronomic
//   (net ≈12–22 min).
// - ≥7.5 s between any two of a user's ads app-wide — the same stamp covers
//   the 5 s no-ad window around manual posts (manual sends stamp it too).
// - Attached-only: no device subscribed to the identity ⇒ the whole
//   campaign holds; the expiry clock keeps running.
// - A refused ad (in-window: our own gate, or a live ERR 56 from another
//   client's post) pauses that channel VISIBLY and auto-resumes when the
//   window reopens (decided 2026-07-20). A kick/ban/leave stops the
//   channel permanently.
// - Absolute expiry: the scheduler never posts past `expiresAt` no matter
//   what in-memory state says.
//
// Definition + coarse per-channel outcome persist in the `campaigns` row
// (write-through, fire-and-forget); the jittered timeline is volatile and
// rebuilt with a fresh start stagger on boot.

import { asc, eq } from "drizzle-orm";
import { mdToBBCode } from "@emberchat/markdown-bbcode";
import { FchatErrorCode } from "@emberchat/fchat-protocol";
import {
  CAMPAIGN_DURATION_MS,
  type CampaignChannelDto,
  type CampaignDto,
} from "@emberchat/protocol";
import type { Db } from "../../db/index.js";
import { ads, campaigns, flistAccounts, identities } from "../../db/schema.js";
import type { HistorySink } from "../history/sink.js";
import {
  AdCooldownError,
  SessionNotOnlineError,
  type FchatSession,
  type SessionLogger,
} from "../session-engine/fchat-session.js";
import type { SessionRegistry } from "../session-engine/registry.js";

export const CAMPAIGN_TICK_MS = 5_000;
/** The per-channel schedule floor — well above the 10-min flood window. */
export const CAMPAIGN_BASE_INTERVAL_MS = 12 * 60_000;
/** Per-post jitter over the floor (net ≈12–22 min, the Horizon shape). */
export const CAMPAIGN_INTERVAL_JITTER_MS = 10 * 60_000;
/** First-post stagger after Start — rotation never fires instantly. */
export const CAMPAIGN_START_JITTER_MS = 3 * 60_000;
/** Minimum gap between any two of a user's ads, campaign or manual. */
export const CAMPAIGN_AD_SPACING_MS = 7_500;
/** A live ERR 56 this soon after our own campaign LRP is attributed to it
 * (LRP carries no correlation on the wire). */
const REFUSAL_ATTRIBUTION_MS = 3_000;

/** The community `[ads: N min]` cadence token (mirrors the web parser in
 * post-ads-logic.ts — a display convention there, an enforced floor here). */
const CADENCE_RE = /\[ads:\s*(\d{1,4})\s*min(?:ute)?s?\]/i;

/** User-facing refusals from the campaign cmd surface (plain language). */
export class CampaignError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CampaignError";
  }
}

interface RuntimeChannel {
  key: string;
  state: "active" | "refused" | "removed";
  nextAt?: number;
  retryAt?: number;
  lastAt?: number;
  posts: number;
  cycleIndex: number;
  /** Sticky note for the run summary ("removed at HH:MM" etc.). */
  removedAt?: number;
}

interface Runtime {
  id: string;
  identityId: string;
  userId: string;
  tags: string[];
  channels: RuntimeChannel[];
  startedAt: number;
  expiresAt: number;
  stoppedAt?: number;
  attached: boolean;
  /** The expiry sys-lines fired once. */
  expiredNotified: boolean;
}

/** The slice of GatewayHub the scheduler needs (stubbed in tests). */
export interface CampaignHub {
  hasSubscribers: (identityId: string) => boolean;
  broadcast: (
    identityId: string,
    event: { kind: "campaign.updated"; d: { campaign: CampaignDto | null } },
  ) => void;
}

export interface CampaignSchedulerOptions {
  db: Db;
  sessions: Pick<SessionRegistry, "get">;
  hub: CampaignHub;
  history?: Pick<HistorySink, "appendSystemLine">;
  logger?: SessionLogger;
  /** Test knobs — production uses the policy constants above. */
  tickMs?: number;
  baseIntervalMs?: number;
  intervalJitterMs?: number;
  startJitterMs?: number;
  spacingMs?: number;
  random?: () => number;
  now?: () => number;
}

const NOOP_LOGGER: SessionLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

export class CampaignScheduler {
  readonly #db: Db;
  readonly #sessions: Pick<SessionRegistry, "get">;
  readonly #hub: CampaignHub;
  readonly #history: Pick<HistorySink, "appendSystemLine"> | undefined;
  readonly #log: SessionLogger;
  readonly #tickMs: number;
  readonly #baseMs: number;
  readonly #jitterMs: number;
  readonly #startJitterMs: number;
  readonly #spacingMs: number;
  readonly #random: () => number;
  readonly #now: () => number;

  readonly #runtimes = new Map<string, Runtime>();
  /** Last ad send per app user — campaign posts stamp it here, manual
   * posts via the session "sent" listener below. */
  readonly #lastAdAtByUser = new Map<string, number>();
  /** Our own most recent LRP per identity, for ERR 56 attribution. */
  readonly #lastCampaignPost = new Map<
    string,
    { channel: string; at: number }
  >();
  /** Sessions already carrying our listeners. */
  readonly #hooked = new WeakSet<FchatSession>();
  #timer: NodeJS.Timeout | undefined;
  #ticking = false;

  constructor(options: CampaignSchedulerOptions) {
    this.#db = options.db;
    this.#sessions = options.sessions;
    this.#hub = options.hub;
    this.#history = options.history;
    this.#log = options.logger ?? NOOP_LOGGER;
    this.#tickMs = options.tickMs ?? CAMPAIGN_TICK_MS;
    this.#baseMs = options.baseIntervalMs ?? CAMPAIGN_BASE_INTERVAL_MS;
    this.#jitterMs = options.intervalJitterMs ?? CAMPAIGN_INTERVAL_JITTER_MS;
    this.#startJitterMs = options.startJitterMs ?? CAMPAIGN_START_JITTER_MS;
    this.#spacingMs = options.spacingMs ?? CAMPAIGN_AD_SPACING_MS;
    this.#random = options.random ?? Math.random;
    this.#now = options.now ?? Date.now;
  }

  /** Loads persisted campaigns and starts the tick loop. */
  async start(): Promise<void> {
    const rows = await this.#db
      .select({
        id: campaigns.id,
        identityId: campaigns.identityId,
        userId: flistAccounts.userId,
        tags: campaigns.tags,
        channels: campaigns.channels,
        startedAt: campaigns.startedAt,
        expiresAt: campaigns.expiresAt,
        stoppedAt: campaigns.stoppedAt,
      })
      .from(campaigns)
      .innerJoin(identities, eq(campaigns.identityId, identities.id))
      .innerJoin(
        flistAccounts,
        eq(identities.flistAccountId, flistAccounts.id),
      );
    const now = this.#now();
    for (const row of rows) {
      this.#runtimes.set(row.identityId, {
        id: row.id,
        identityId: row.identityId,
        userId: row.userId,
        tags: row.tags,
        channels: row.channels.map((c) => ({
          key: c.key,
          // "waiting" was only ever a render state; runtime keeps the
          // three real ones.
          state: c.state === "waiting" ? "active" : c.state,
          lastAt: c.lastAt,
          retryAt: c.retryAt,
          posts: c.posts,
          cycleIndex: c.cycleIndex,
          // A fresh jittered timeline: the volatile nextAt does not
          // survive restarts, and restarting must not burst-post.
          ...(c.state === "removed"
            ? {}
            : { nextAt: now + this.#startDelay() }),
        })),
        startedAt: row.startedAt.getTime(),
        expiresAt: row.expiresAt.getTime(),
        stoppedAt: row.stoppedAt?.getTime(),
        attached: false,
        expiredNotified: row.expiresAt.getTime() <= now,
      });
    }
    this.#timer = setInterval(() => {
      void this.#tick();
    }, this.#tickMs);
    this.#timer.unref?.();
  }

  stop(): void {
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }
  }

  dtoFor(identityId: string): CampaignDto | null {
    const runtime = this.#runtimes.get(identityId);
    return runtime ? this.#dto(runtime) : null;
  }

  /** `campaign.start` — validates against the live session and library. */
  async startCampaign(
    identityId: string,
    userId: string,
    input: { tags: string[]; channels: string[]; replace?: boolean },
  ): Promise<void> {
    const existing = this.#runtimes.get(identityId);
    const now = this.#now();
    if (
      existing &&
      existing.stoppedAt === undefined &&
      now < existing.expiresAt &&
      input.replace !== true
    ) {
      throw new CampaignError(
        "A campaign is already running — replacing it needs an explicit confirmation",
      );
    }
    const session = this.#sessions.get(identityId);
    if (!session || session.status !== "online") {
      throw new CampaignError("This character isn't connected right now");
    }
    const channels: RuntimeChannel[] = [];
    for (const key of input.channels) {
      const channel = this.#findChannel(session, key);
      if (!channel) {
        throw new CampaignError(
          `You're not in one of those channels any more (${key})`,
        );
      }
      if (channel.state.mode === "chat") {
        throw new CampaignError(
          `${channel.state.title || key} doesn't allow ads`,
        );
      }
      channels.push({
        key: channel.key,
        state: "active",
        nextAt: now + this.#startDelay(),
        posts: 0,
        cycleIndex: 0,
      });
    }
    const rotation = await this.#rotationSet(identityId, input.tags);
    if (rotation.length === 0) {
      throw new CampaignError(
        "None of your enabled ads carry those tags — nothing would post",
      );
    }
    const runtime: Runtime = {
      // The DB default assigns the real id on first insert; a placeholder
      // is fine in memory (the row upserts on identityId).
      id: existing?.id ?? "",
      identityId,
      userId,
      tags: [...new Set(input.tags)],
      channels,
      startedAt: now,
      expiresAt: now + CAMPAIGN_DURATION_MS,
      attached: this.#hub.hasSubscribers(identityId),
      expiredNotified: false,
    };
    this.#runtimes.set(identityId, runtime);
    await this.#persist(runtime);
    this.#broadcast(runtime);
  }

  /** `campaign.stop` — the global kill switch. */
  async stopCampaign(identityId: string): Promise<void> {
    const runtime = this.#require(identityId);
    runtime.stoppedAt = this.#now();
    await this.#persist(runtime);
    this.#broadcast(runtime);
  }

  /** `campaign.renew` — another hour from now (also revives an expired or
   * stopped campaign; removed channels stay removed). */
  async renewCampaign(identityId: string): Promise<void> {
    const runtime = this.#require(identityId);
    const now = this.#now();
    runtime.stoppedAt = undefined;
    runtime.expiresAt = now + CAMPAIGN_DURATION_MS;
    runtime.expiredNotified = false;
    for (const channel of runtime.channels) {
      if (channel.state !== "removed" && channel.nextAt === undefined) {
        channel.nextAt = now + this.#startDelay();
      }
    }
    await this.#persist(runtime);
    this.#broadcast(runtime);
  }

  /** `campaign.drop` — remove one channel (the removed-row "Drop ×"). */
  async dropChannel(identityId: string, key: string): Promise<void> {
    const runtime = this.#require(identityId);
    const before = runtime.channels.length;
    runtime.channels = runtime.channels.filter(
      (c) => c.key.toLowerCase() !== key.toLowerCase(),
    );
    if (runtime.channels.length === before) {
      throw new CampaignError("That channel isn't part of the campaign");
    }
    await this.#persist(runtime);
    this.#broadcast(runtime);
  }

  /** One pass — exported for deterministic tests (`tickOnce`). */
  async tickOnce(): Promise<void> {
    await this.#tick();
  }

  #require(identityId: string): Runtime {
    const runtime = this.#runtimes.get(identityId);
    if (!runtime) {
      throw new CampaignError("There's no campaign for this character");
    }
    return runtime;
  }

  #startDelay(): number {
    // Never instant, never in lockstep: a spacing beat plus jitter.
    return this.#spacingMs + this.#random() * this.#startJitterMs;
  }

  #intervalFor(session: FchatSession | undefined, key: string): number {
    let floorMs = this.#baseMs;
    const channel = session ? this.#findChannel(session, key) : undefined;
    const match = channel ? CADENCE_RE.exec(channel.state.description) : null;
    if (match) {
      const requested = Number(match[1]) * 60_000;
      if (requested > floorMs) {
        floorMs = requested;
      }
    }
    // The live flood VAR is the wire's floor — honored if it ever exceeds
    // the schedule's own.
    const flood = session ? session.state.vars.lfrp_flood * 1000 : 0;
    if (flood > floorMs) {
      floorMs = flood;
    }
    return floorMs + this.#random() * this.#jitterMs;
  }

  #findChannel(
    session: FchatSession,
    key: string,
  ):
    | {
        key: string;
        state: { mode: string; description: string; title: string };
      }
    | undefined {
    const lower = key.toLowerCase();
    for (const [candidate, state] of session.state.channels) {
      if (candidate.toLowerCase() === lower) {
        return { key: candidate, state };
      }
    }
    return undefined;
  }

  async #rotationSet(
    identityId: string,
    tags: string[],
  ): Promise<{ id: string; content: string }[]> {
    const wanted = new Set(tags.map((tag) => tag.toLowerCase()));
    const rows = await this.#db
      .select({
        id: ads.id,
        content: ads.content,
        tags: ads.tags,
        disabled: ads.disabled,
      })
      .from(ads)
      .where(eq(ads.identityId, identityId))
      .orderBy(asc(ads.sortOrder), asc(ads.id));
    return rows
      .filter(
        (row) =>
          !row.disabled &&
          row.tags.some((tag) => wanted.has(tag.toLowerCase())),
      )
      .map((row) => ({ id: row.id, content: row.content }));
  }

  /** Wires the manual-post spacing stamp + ERR 56 attribution onto a
   * session's bus (once per session object). */
  #hookSession(runtime: Runtime, session: FchatSession): void {
    if (this.#hooked.has(session)) {
      return;
    }
    this.#hooked.add(session);
    session.events.on("sent", (sent: { kind: string }) => {
      if (sent.kind === "ad") {
        this.#lastAdAtByUser.set(runtime.userId, this.#now());
      }
    });
    session.events.on(
      "command",
      (command: { cmd: string; payload?: unknown }) => {
        if (command.cmd !== "ERR") {
          return;
        }
        const payload = command.payload as { number: number };
        if (payload.number !== (FchatErrorCode.AdFlood as number)) {
          return;
        }
        const last = this.#lastCampaignPost.get(runtime.identityId);
        const current = this.#runtimes.get(runtime.identityId);
        if (
          !last ||
          !current ||
          this.#now() - last.at > REFUSAL_ATTRIBUTION_MS
        ) {
          return;
        }
        const channel = current.channels.find((c) => c.key === last.channel);
        if (channel && channel.state === "active") {
          channel.state = "refused";
          channel.nextAt = undefined;
          const flood = session.state.vars.lfrp_flood * 1000;
          channel.retryAt = this.#now() + (flood > 0 ? flood : this.#baseMs);
          void this.#persist(current);
          this.#broadcast(current);
        }
      },
    );
  }

  async #tick(): Promise<void> {
    if (this.#ticking) {
      return;
    }
    this.#ticking = true;
    try {
      for (const runtime of this.#runtimes.values()) {
        try {
          await this.#tickCampaign(runtime);
        } catch (error) {
          this.#log.error(
            { identityId: runtime.identityId, error: String(error) },
            "campaign tick failed",
          );
        }
      }
    } finally {
      this.#ticking = false;
    }
  }

  async #tickCampaign(runtime: Runtime): Promise<void> {
    const now = this.#now();
    let changed = false;

    // Attachment flips are announced even while stopped/expired — the
    // status surface reads them.
    const attached = this.#hub.hasSubscribers(runtime.identityId);
    if (attached !== runtime.attached) {
      runtime.attached = attached;
      changed = true;
    }

    const session = this.#sessions.get(runtime.identityId);
    if (session) {
      this.#hookSession(runtime, session);
    }
    const online = session?.status === "online";

    const running = runtime.stoppedAt === undefined && now < runtime.expiresAt;

    // Expiry is announced exactly once, with a plain sys line in each
    // still-rotating channel's log.
    if (
      runtime.stoppedAt === undefined &&
      now >= runtime.expiresAt &&
      !runtime.expiredNotified
    ) {
      runtime.expiredNotified = true;
      changed = true;
      if (session && this.#history) {
        for (const channel of runtime.channels) {
          if (channel.state !== "removed") {
            this.#history.appendSystemLine(
              runtime.identityId,
              session,
              channel.key,
              "Your ad rotation here ended after its hour — renew it to keep posting.",
            );
          }
        }
      }
    }

    for (const channel of runtime.channels) {
      // Refused channels resume on their own when the window reopens —
      // visibly paused, never silently retried in-window.
      if (
        channel.state === "refused" &&
        channel.retryAt !== undefined &&
        now >= channel.retryAt
      ) {
        channel.state = "active";
        channel.retryAt = undefined;
        channel.nextAt =
          now + this.#spacingMs + this.#random() * this.#jitterMs;
        changed = true;
      }
      // A channel we're no longer in (kick, ban, or leaving) stops
      // permanently. Only judged against a live, seeded session — a
      // reconnect mid-rejoin must not read as a removal.
      if (
        channel.state !== "removed" &&
        online &&
        session !== undefined &&
        this.#findChannel(session, channel.key) === undefined
      ) {
        channel.state = "removed";
        channel.nextAt = undefined;
        channel.retryAt = undefined;
        channel.removedAt = now;
        changed = true;
      }
    }

    // Post at most one due channel per campaign per tick; the app-wide
    // spacing stamp throttles across campaigns and manual posts alike.
    if (running && attached && online && session) {
      const lastAd = this.#lastAdAtByUser.get(runtime.userId) ?? 0;
      if (now - lastAd >= this.#spacingMs) {
        const due = runtime.channels.find(
          (c) =>
            c.state === "active" && c.nextAt !== undefined && now >= c.nextAt,
        );
        if (due) {
          changed = (await this.#post(runtime, session, due)) || changed;
        }
      }
    }

    if (changed) {
      await this.#persist(runtime);
      this.#broadcast(runtime);
    }
  }

  async #post(
    runtime: Runtime,
    session: FchatSession,
    channel: RuntimeChannel,
  ): Promise<boolean> {
    const now = this.#now();
    const rotation = await this.#rotationSet(runtime.identityId, runtime.tags);
    if (rotation.length === 0) {
      // The library changed under the campaign (ads disabled/deleted) —
      // nothing to post; try again next interval rather than spinning.
      channel.nextAt = now + this.#intervalFor(session, channel.key);
      return true;
    }
    const ad = rotation[channel.cycleIndex % rotation.length]!;
    try {
      await session.sendChannelAd(channel.key, mdToBBCode(ad.content).trim());
      this.#lastAdAtByUser.set(runtime.userId, now);
      this.#lastCampaignPost.set(runtime.identityId, {
        channel: channel.key,
        at: now,
      });
      channel.lastAt = now;
      channel.posts += 1;
      channel.cycleIndex = (channel.cycleIndex + 1) % rotation.length;
      channel.nextAt = now + this.#intervalFor(session, channel.key);
      return true;
    } catch (error) {
      if (error instanceof AdCooldownError) {
        // Another client posted into this channel's window — pause
        // visibly, resume when it reopens.
        channel.state = "refused";
        channel.nextAt = undefined;
        channel.retryAt = now + session.adWaitMs(channel.key);
        return true;
      }
      if (error instanceof SessionNotOnlineError) {
        // The socket dropped mid-tick; the next tick re-evaluates.
        return false;
      }
      // Anything else (an over-long translated ad, unexpected refusals):
      // skip this ad, advance the cycle, keep the channel alive.
      this.#log.warn(
        {
          identityId: runtime.identityId,
          channel: channel.key,
          error: String(error),
        },
        "campaign post failed; advancing cycle",
      );
      channel.cycleIndex = (channel.cycleIndex + 1) % rotation.length;
      channel.nextAt = now + this.#intervalFor(session, channel.key);
      return true;
    }
  }

  #dto(runtime: Runtime): CampaignDto {
    const channels: CampaignChannelDto[] = runtime.channels.map((c) => ({
      key: c.key,
      // Held campaigns read as waiting everywhere non-terminal.
      state: !runtime.attached && c.state === "active" ? "waiting" : c.state,
      ...(c.nextAt !== undefined && runtime.attached
        ? { nextAt: Math.round(c.nextAt) }
        : {}),
      ...(c.retryAt !== undefined ? { retryAt: Math.round(c.retryAt) } : {}),
      ...(c.lastAt !== undefined ? { lastAt: Math.round(c.lastAt) } : {}),
      posts: c.posts,
    }));
    return {
      id: runtime.id,
      tags: runtime.tags,
      startedAt: runtime.startedAt,
      expiresAt: runtime.expiresAt,
      ...(runtime.stoppedAt !== undefined
        ? { stoppedAt: runtime.stoppedAt }
        : {}),
      attached: runtime.attached,
      channels,
    };
  }

  #broadcast(runtime: Runtime): void {
    this.#hub.broadcast(runtime.identityId, {
      kind: "campaign.updated",
      d: { campaign: this.#dto(runtime) },
    });
  }

  async #persist(runtime: Runtime): Promise<void> {
    try {
      const values = {
        identityId: runtime.identityId,
        tags: runtime.tags,
        channels: runtime.channels.map((c) => ({
          key: c.key,
          state: c.state,
          ...(c.lastAt !== undefined ? { lastAt: Math.round(c.lastAt) } : {}),
          ...(c.retryAt !== undefined
            ? { retryAt: Math.round(c.retryAt) }
            : {}),
          posts: c.posts,
          cycleIndex: c.cycleIndex,
        })),
        startedAt: new Date(runtime.startedAt),
        expiresAt: new Date(runtime.expiresAt),
        stoppedAt:
          runtime.stoppedAt !== undefined ? new Date(runtime.stoppedAt) : null,
      };
      const [row] = await this.#db
        .insert(campaigns)
        .values(values)
        .onConflictDoUpdate({
          target: campaigns.identityId,
          set: {
            tags: values.tags,
            channels: values.channels,
            startedAt: values.startedAt,
            expiresAt: values.expiresAt,
            stoppedAt: values.stoppedAt,
          },
        })
        .returning({ id: campaigns.id });
      if (row) {
        runtime.id = row.id;
      }
    } catch (error) {
      // A missed write self-heals on the next change; the in-memory
      // runtime stays authoritative for the process lifetime.
      this.#log.error(
        { identityId: runtime.identityId, error: String(error) },
        "campaign persist failed",
      );
    }
  }
}
