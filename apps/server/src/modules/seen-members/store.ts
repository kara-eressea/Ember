// Seen-members store (#200): persists a per-channel roster of departed
// members so the member list can show a "Seen recently" group across client
// AND server restarts. Subscribes to each session's command bus like the
// history sink; live fan-out needs no dedicated event — clients derive the
// same moves from the existing member.join / member.leave flow, and the
// snapshot serves the persisted rows on every sub.
//
// The store keeps its own lightweight membership mirror (channel → nick →
// gender) because session state applies commands BEFORE the bus emits: by
// the time FLN/LCH reach us the roster no longer knows which channels the
// character was in (or their gender). The mirror is rebuilt from ICH on
// every (re)join and cleared whenever the connection drops — a disconnect
// is OUR line going away, not everyone else leaving, so it must never
// stamp lastSeen.

import { and, eq, inArray, lt, sql } from "drizzle-orm";
import type { ServerCommand } from "@emberchat/fchat-protocol";
import type { SeenMemberDto } from "@emberchat/protocol";
import type { Db } from "../../db/index.js";
import { seenMembers } from "../../db/schema.js";
import type { SessionLogger } from "../session-engine/fchat-session.js";
import type { SessionEventBus } from "../session-engine/event-bus.js";
import type { SessionState } from "../session-engine/session-state.js";

/** F-Chat resolves character names case-insensitively; own-character filters
 * must fold case or a frame whose casing diverges from ownCharacter slips the
 * guard and mis-stamps our own moves (#265). */
function sameCharacter(a: string, b: string | undefined): boolean {
  return b !== undefined && a.toLowerCase() === b.toLowerCase();
}

/** Rows older than this are aged out (spec: retention ~1 week). */
export const SEEN_RETENTION_MS = 7 * 86_400_000;
/** Per-channel ceiling (spec: a few hundred); oldest lastSeen evicts first. */
export const SEEN_CAP_PER_CHANNEL = 300;
/** How often the background sweep ages out expired rows. */
export const SEEN_SWEEP_INTERVAL_MS = 3_600_000;

/** The slice of FchatSession the store consumes (test seam). */
export interface SeenSessionLike {
  readonly events: SessionEventBus;
  readonly state: SessionState;
}

const NOOP_LOGGER: SessionLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

export interface SeenMembersStoreOptions {
  readonly db: Db;
  readonly logger?: SessionLogger;
  readonly retentionMs?: number;
  readonly capPerChannel?: number;
  readonly sweepIntervalMs?: number;
  /** Test-only clock. */
  readonly now?: () => Date;
}

interface MirrorEntry {
  character: string;
  gender: string;
}

export class SeenMembersStore {
  readonly #db: Db;
  readonly #log: SessionLogger;
  readonly #retentionMs: number;
  readonly #cap: number;
  readonly #sweepIntervalMs: number;
  readonly #now: () => Date;
  /** identityId → channelKey → lower(nick) → entry. */
  readonly #mirrors = new Map<string, Map<string, Map<string, MirrorEntry>>>();
  readonly #detach = new Map<string, () => void>();
  /** Serial write queue: an FLN upsert racing a rejoin's delete must land
   * in command order or a departed ghost row could resurrect. */
  #queue: Promise<void> = Promise.resolve();
  #timer: NodeJS.Timeout | undefined;

  constructor(options: SeenMembersStoreOptions) {
    this.#db = options.db;
    this.#log = options.logger ?? NOOP_LOGGER;
    this.#retentionMs = options.retentionMs ?? SEEN_RETENTION_MS;
    this.#cap = options.capPerChannel ?? SEEN_CAP_PER_CHANNEL;
    this.#sweepIntervalMs = options.sweepIntervalMs ?? SEEN_SWEEP_INTERVAL_MS;
    this.#now = options.now ?? (() => new Date());
  }

  /** Starts the periodic retention sweep. */
  start(): void {
    if (this.#timer) {
      return;
    }
    this.#timer = setInterval(() => {
      void this.sweepOnce();
    }, this.#sweepIntervalMs);
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }
  }

  /** Deletes rows older than the retention window; returns how many. */
  async sweepOnce(): Promise<{ deleted: number }> {
    try {
      const cutoff = new Date(this.#now().getTime() - this.#retentionMs);
      const rows = await this.#db
        .delete(seenMembers)
        .where(lt(seenMembers.lastSeenAt, cutoff))
        .returning({ id: sql<number>`1` });
      return { deleted: rows.length };
    } catch (error) {
      // Aging out is best-effort; the next tick retries.
      this.#log.error({ err: error }, "seen-members sweep failed");
      return { deleted: 0 };
    }
  }

  /**
   * Called from onSessionStarted, before the session connects (so no part
   * is ever missed). A restarted identity gets a fresh session object;
   * the previous subscription is detached first.
   */
  attach(identityId: string, session: SeenSessionLike): void {
    this.#detach.get(identityId)?.();
    this.#mirrors.set(identityId, new Map());
    const offCommand = session.events.on("command", (command) => {
      this.#handle(identityId, session.state, command);
    });
    const offStatus = session.events.on("status", ({ status }) => {
      if (status !== "online") {
        // The connection dropped (or is being replaced): membership is
        // unknown until the next ICH. Never stamp lastSeen on our own
        // disconnect — those members did not leave.
        this.#mirrors.get(identityId)?.clear();
      }
      if (status === "stopped") {
        detach();
      }
    });
    const detach = () => {
      offCommand();
      offStatus();
      this.#mirrors.delete(identityId);
      this.#detach.delete(identityId);
    };
    this.#detach.set(identityId, detach);
  }

  /** Settles once every write enqueued so far has landed (tests). */
  async idle(): Promise<void> {
    await this.#queue;
  }

  #handle(
    identityId: string,
    state: SessionState,
    command: ServerCommand,
  ): void {
    const mirror = this.#mirrors.get(identityId);
    if (!mirror) {
      return;
    }
    switch (command.cmd) {
      case "JCH": {
        const { channel: key, character } = command.payload;
        if (sameCharacter(character.identity, state.ownCharacter)) {
          // Our own join: the ICH that follows seeds the mirror.
          return;
        }
        let channel = mirror.get(key);
        if (!channel) {
          channel = new Map();
          mirror.set(key, channel);
        }
        const presence = state.characters.get(character.identity);
        channel.set(character.identity.toLowerCase(), {
          character: character.identity,
          gender: presence?.gender ?? "",
        });
        // A rejoin moves the nick out of the seen roster.
        this.#enqueue(() =>
          this.#deleteSeen(identityId, key, [character.identity.toLowerCase()]),
        );
        return;
      }
      case "ICH": {
        const key = command.payload.channel;
        const channel = new Map<string, MirrorEntry>();
        for (const user of command.payload.users) {
          const presence = state.characters.get(user.identity);
          channel.set(user.identity.toLowerCase(), {
            character: user.identity,
            gender: presence?.gender ?? "",
          });
        }
        mirror.set(key, channel);
        // Everyone present must leave the seen roster (never in both) —
        // covers parts we missed while the server was down.
        this.#enqueue(() =>
          this.#deleteSeen(identityId, key, [...channel.keys()]),
        );
        return;
      }
      case "NLN": {
        // Genders arrive with global presence; refresh mirror entries so a
        // later part stores the right colour even if NLN followed the JCH.
        const lower = command.payload.identity.toLowerCase();
        for (const channel of mirror.values()) {
          const entry = channel.get(lower);
          if (entry) {
            entry.gender = command.payload.gender;
          }
        }
        return;
      }
      case "LCH":
      case "CKU":
      case "CBU":
      case "CTU": {
        const { channel: key, character } = command.payload;
        if (sameCharacter(character, state.ownCharacter)) {
          // Our own departure: the channel's roster is no longer observed.
          mirror.delete(key);
          return;
        }
        const channel = mirror.get(key);
        if (!channel) {
          // A channel we no longer observe (e.g. after our own leave) —
          // never record parts we can't vouch for.
          return;
        }
        const lower = character.toLowerCase();
        const entry = channel.get(lower);
        channel.delete(lower);
        this.#upsert(identityId, key, {
          character: entry?.character ?? character,
          // LCH precedes any FLN, so the roster still knows the gender.
          gender:
            entry?.gender ?? state.characters.get(character)?.gender ?? "",
        });
        return;
      }
      case "FLN": {
        // A global leave: the character departs every channel we observe.
        const { character } = command.payload;
        if (sameCharacter(character, state.ownCharacter)) {
          return;
        }
        const lower = character.toLowerCase();
        for (const [key, channel] of mirror) {
          const entry = channel.get(lower);
          if (entry) {
            channel.delete(lower);
            this.#upsert(identityId, key, entry);
          }
        }
        return;
      }
      default:
        return;
    }
  }

  #upsert(identityId: string, channelKey: string, member: MirrorEntry): void {
    this.#enqueue(async () => {
      const lastSeenAt = this.#now();
      await this.#db
        .insert(seenMembers)
        .values({
          identityId,
          channelKey,
          characterLower: member.character.toLowerCase(),
          character: member.character,
          gender: member.gender,
          lastSeenAt,
        })
        .onConflictDoUpdate({
          target: [
            seenMembers.identityId,
            seenMembers.channelKey,
            seenMembers.characterLower,
          ],
          set: {
            character: member.character,
            gender: member.gender,
            lastSeenAt,
          },
        });
      // Silent cap eviction (spec §6): drop whatever fell past the cap,
      // oldest lastSeen first.
      await this.#db.execute(sql`
        delete from seen_members
        where identity_id = ${identityId}
          and channel_key = ${channelKey}
          and character_lower in (
            select character_lower from seen_members
            where identity_id = ${identityId} and channel_key = ${channelKey}
            order by last_seen_at desc
            offset ${this.#cap}
          )
      `);
    });
  }

  async #deleteSeen(
    identityId: string,
    channelKey: string,
    lowers: string[],
  ): Promise<void> {
    if (lowers.length === 0) {
      return;
    }
    await this.#db
      .delete(seenMembers)
      .where(
        and(
          eq(seenMembers.identityId, identityId),
          eq(seenMembers.channelKey, channelKey),
          inArray(seenMembers.characterLower, lowers),
        ),
      );
  }

  #enqueue(write: () => Promise<void>): void {
    this.#queue = this.#queue.then(write).catch((error: unknown) => {
      // One failed write must not wedge the queue.
      this.#log.error({ err: error }, "seen-members write failed");
    });
  }
}

/**
 * The identity's persisted seen rosters, channelKey → newest-first DTOs —
 * the snapshot's serve path. Expired rows are filtered at read time too,
 * so a stale row never outlives retention just because the sweep hasn't
 * ticked yet.
 */
export async function seenByChannel(
  db: Db,
  identityId: string,
  options?: { retentionMs?: number; now?: () => Date },
): Promise<Map<string, SeenMemberDto[]>> {
  const retentionMs = options?.retentionMs ?? SEEN_RETENTION_MS;
  const now = options?.now?.() ?? new Date();
  const cutoff = new Date(now.getTime() - retentionMs);
  const rows = await db
    .select({
      channelKey: seenMembers.channelKey,
      character: seenMembers.character,
      gender: seenMembers.gender,
      lastSeenAt: seenMembers.lastSeenAt,
    })
    .from(seenMembers)
    .where(eq(seenMembers.identityId, identityId))
    .orderBy(sql`${seenMembers.lastSeenAt} desc`);
  const byChannel = new Map<string, SeenMemberDto[]>();
  for (const row of rows) {
    if (row.lastSeenAt < cutoff) {
      continue;
    }
    let list = byChannel.get(row.channelKey);
    if (!list) {
      list = [];
      byChannel.set(row.channelKey, list);
    }
    list.push({
      character: row.character,
      gender: row.gender,
      lastSeen: row.lastSeenAt.getTime(),
    });
  }
  return byChannel;
}
