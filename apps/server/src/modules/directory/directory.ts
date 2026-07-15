// Channel directory cache (M6). One F-Chat server, one directory: CHA/ORS
// responses replace the channel_directory table wholesale per kind, shared
// across every user. A refresh is one wire round-trip per cooldown window —
// browsers opening the channel browser repeatedly serve from the cache, and
// the client shows refreshed_at so point-in-time counts stay honest
// (design/milestone-6-channel-browser-ops.md).

import { eq } from "drizzle-orm";
import type { Db } from "../../db/index.js";
import { channelDirectory } from "../../db/schema.js";
import type { FchatSession } from "../session-engine/fchat-session.js";

/** Cache age below which a refresh request serves the cache without touching
 * the wire. The listings move slowly; the cooldown keeps a busy browser-open
 * habit from becoming CHA/ORS spam. */
export const DIRECTORY_REFRESH_COOLDOWN_MS = 60_000;
/** How long a refresh waits for the CHA+ORS responses before serving
 * whatever the cache holds. Never an error — staleness is displayable. */
export const DIRECTORY_RESPONSE_TIMEOUT_MS = 10_000;

export type DirectoryKind = "official" | "open";

export interface DirectoryChannel {
  /** F-Chat channel name (official) or ADH- id (open room). */
  key: string;
  kind: DirectoryKind;
  title: string;
  /** Member count as of refreshedAt — point-in-time by nature. */
  characters: number;
}

export interface DirectorySnapshot {
  channels: DirectoryChannel[];
  /** When the cache was last replaced; null while it has never been. */
  refreshedAt: Date | null;
}

export interface DirectoryLogger {
  warn: (obj: object, msg: string) => void;
  error: (obj: object, msg: string) => void;
}

export interface ChannelDirectoryOptions {
  readonly cooldownMs?: number;
  readonly responseTimeoutMs?: number;
  readonly now?: () => number;
}

/** The slice of FchatSession the directory needs (narrow for tests). */
export type DirectorySession = Pick<
  FchatSession,
  "events" | "requestChannelLists" | "status"
>;

export class ChannelDirectory {
  readonly #db: Db;
  readonly #log: DirectoryLogger;
  readonly #cooldownMs: number;
  readonly #responseTimeoutMs: number;
  readonly #now: () => number;
  /** Serializes table replacements — two sessions answering CHA at once must
   * not interleave delete/insert of the same primary keys. */
  #writeQueue: Promise<void> = Promise.resolve();
  /** Refresh single-flight: concurrent browser opens share one round-trip. */
  #inflight: Promise<void> | undefined;
  readonly #waiters: Record<DirectoryKind, (() => void)[]> = {
    official: [],
    open: [],
  };

  constructor(
    db: Db,
    logger: DirectoryLogger,
    options: ChannelDirectoryOptions = {},
  ) {
    this.#db = db;
    this.#log = logger;
    this.#cooldownMs = options.cooldownMs ?? DIRECTORY_REFRESH_COOLDOWN_MS;
    this.#responseTimeoutMs =
      options.responseTimeoutMs ?? DIRECTORY_RESPONSE_TIMEOUT_MS;
    this.#now = options.now ?? Date.now;
  }

  /** Resolves once every replacement enqueued so far has committed. Test
   * hook: sleeping "long enough" for the queue flakes on loaded runners. */
  async flushWrites(): Promise<void> {
    await this.#writeQueue;
  }

  /** Subscribes to a session's inbound commands; any CHA/ORS response —
   * whoever requested it — replaces the shared cache. */
  attach(session: DirectorySession): void {
    session.events.on("command", (command) => {
      if (command.cmd === "CHA") {
        this.#enqueueReplace(
          "official",
          command.payload.channels.map((channel) => ({
            key: channel.name,
            title: channel.name,
            characters: channel.characters,
          })),
        );
      } else if (command.cmd === "ORS") {
        this.#enqueueReplace(
          "open",
          command.payload.channels.map((channel) => ({
            key: channel.name,
            title: channel.title,
            characters: channel.characters,
          })),
        );
      }
    });
  }

  /**
   * The directory, refreshed over the given session when the cache is past
   * the cooldown. Serves the cache as-is (with its honest refreshedAt) when
   * no online session is available or the responses do not arrive in time —
   * a browse must degrade to stale data, never to an error.
   */
  async get(session?: DirectorySession): Promise<DirectorySnapshot> {
    const cached = await this.#read();
    const fresh =
      cached.refreshedAt !== null &&
      this.#now() - cached.refreshedAt.getTime() < this.#cooldownMs;
    if (fresh || session?.status !== "online") {
      return cached;
    }
    this.#inflight ??= this.#refresh(session).finally(() => {
      this.#inflight = undefined;
    });
    await this.#inflight;
    return this.#read();
  }

  async #refresh(session: DirectorySession): Promise<void> {
    const responses = Promise.all([
      this.#waitFor("official"),
      this.#waitFor("open"),
    ]);
    try {
      await session.requestChannelLists();
    } catch (error) {
      this.#log.warn({ err: error }, "directory refresh request failed");
      return;
    }
    await responses;
  }

  /** Resolves once a replacement of the kind committed, or on timeout. */
  #waitFor(kind: DirectoryKind): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const index = this.#waiters[kind].indexOf(done);
        if (index !== -1) {
          this.#waiters[kind].splice(index, 1);
        }
        resolve();
      }, this.#responseTimeoutMs);
      const done = (): void => {
        clearTimeout(timer);
        resolve();
      };
      this.#waiters[kind].push(done);
    });
  }

  #enqueueReplace(
    kind: DirectoryKind,
    rows: { key: string; title: string; characters: number }[],
  ): void {
    this.#writeQueue = this.#writeQueue.then(async () => {
      try {
        await this.#db.transaction(async (tx) => {
          await tx
            .delete(channelDirectory)
            .where(eq(channelDirectory.kind, kind));
          if (rows.length > 0) {
            await tx.insert(channelDirectory).values(
              rows.map((row) => ({
                channelKey: row.key,
                kind,
                title: row.title,
                lastSeenCount: row.characters,
                refreshedAt: new Date(this.#now()),
              })),
            );
          }
        });
      } catch (error) {
        this.#log.error({ err: error, kind }, "directory replace failed");
        return;
      }
      for (const waiter of this.#waiters[kind].splice(0)) {
        waiter();
      }
    });
  }

  async #read(): Promise<DirectorySnapshot> {
    const rows = await this.#db
      .select({
        key: channelDirectory.channelKey,
        kind: channelDirectory.kind,
        title: channelDirectory.title,
        characters: channelDirectory.lastSeenCount,
        refreshedAt: channelDirectory.refreshedAt,
      })
      .from(channelDirectory)
      .orderBy(channelDirectory.channelKey);
    let refreshedAt: Date | null = null;
    for (const row of rows) {
      if (refreshedAt === null || row.refreshedAt > refreshedAt) {
        refreshedAt = row.refreshedAt;
      }
    }
    return {
      channels: rows.map(({ key, kind, title, characters }) => ({
        key,
        kind,
        title,
        characters,
      })),
      refreshedAt,
    };
  }
}
