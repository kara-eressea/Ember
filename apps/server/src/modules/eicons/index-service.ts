// Server-local eicon index (M8 step 12). xariah.net has no search API —
// like Horizon/XarChat, we download the full index (base.doc: one
// `name\thash` line per eicon, `# As Of: <unix>` comment) and search it
// in-process, refreshing via EiconsDataDeltaSince/<ts> on a ~daily
// cadence. Queries never leave this server; xariah only ever sees a
// handful of bulk fetches per day. The name list persists in
// flist_mappings (source "eicon-index") so restarts don't re-download.

import { eq } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import type { Db } from "../../db/index.js";
import { flistMappings } from "../../db/schema.js";

const SOURCE = "eicon-index";
const BASE_PATH = "/eicons/Home/EiconsDataBase/base.doc";
const DELTA_PATH = "/eicons/Home/EiconsDataDeltaSince/";

export interface EiconIndexOptions {
  db: Db;
  baseUrl: string;
  /** How stale the index may get before a search triggers a delta fetch. */
  refreshMs: number;
  logger?: FastifyBaseLogger;
  now?: () => number;
}

interface IndexPayload {
  /** Upstream "As Of" stamp (unix seconds) — the next delta cursor. */
  asOf: number;
  names: string[];
}

export class EiconIndexService {
  readonly #db: Db;
  readonly #baseUrl: string;
  readonly #refreshMs: number;
  readonly #logger: FastifyBaseLogger | undefined;
  readonly #now: () => number;

  #names: string[] = [];
  #lowered: string[] = [];
  #asOf = 0;
  /** ms timestamp of the last successful fetch/refresh (0 = never). */
  #syncedAt = 0;
  #inflight: Promise<void> | undefined;

  constructor(options: EiconIndexOptions) {
    this.#db = options.db;
    this.#baseUrl = options.baseUrl.replace(/\/$/, "");
    this.#refreshMs = options.refreshMs;
    this.#logger = options.logger;
    this.#now = options.now ?? Date.now;
  }

  /** Case-insensitive substring search over the local index. Ensures the
   * index exists (DB row or full download) and is within the refresh
   * window first; a failed *refresh* serves the stale index, a failed
   * *initial* download throws. */
  async search(query: string, limit = 60): Promise<string[]> {
    await this.#ensureFresh();
    const needle = query.toLowerCase();
    const results: string[] = [];
    for (let i = 0; i < this.#lowered.length; i += 1) {
      if (this.#lowered[i]!.includes(needle)) {
        results.push(this.#names[i]!);
        if (results.length >= limit) {
          break;
        }
      }
    }
    return results;
  }

  /** Index size + cursor, for logging/tests. */
  get state(): { count: number; asOf: number } {
    return { count: this.#names.length, asOf: this.#asOf };
  }

  async #ensureFresh(): Promise<void> {
    if (this.#inflight) {
      return this.#inflight;
    }
    if (this.#names.length > 0 && this.#age() < this.#refreshMs) {
      return;
    }
    const work = this.#load().finally(() => {
      this.#inflight = undefined;
    });
    this.#inflight = work;
    return work;
  }

  #age(): number {
    return this.#now() - this.#syncedAt;
  }

  async #load(): Promise<void> {
    // Adopt a persisted index first — restarts must not re-download.
    if (this.#names.length === 0) {
      const [row] = await this.#db
        .select({
          payload: flistMappings.payload,
          fetchedAt: flistMappings.fetchedAt,
        })
        .from(flistMappings)
        .where(eq(flistMappings.source, SOURCE))
        .limit(1);
      if (row) {
        // A malformed/legacy row must degrade to a fresh download, not
        // 502 every search until someone hand-deletes it (M8 audit).
        try {
          const payload = row.payload as unknown as IndexPayload;
          if (
            !Array.isArray(payload.names) ||
            typeof payload.asOf !== "number"
          ) {
            throw new Error("persisted eicon index has an unexpected shape");
          }
          this.#adopt(payload.names, payload.asOf, row.fetchedAt.getTime());
        } catch (error) {
          this.#logger?.warn(
            { err: error },
            "persisted eicon index unusable; falling back to a full fetch",
          );
        }
      }
    }
    if (this.#names.length === 0) {
      await this.#fullFetch();
      return;
    }
    if (this.#age() < this.#refreshMs) {
      return;
    }
    try {
      await this.#deltaFetch();
    } catch (error) {
      // A failed refresh keeps serving the stale index. Stamping syncedAt
      // deliberately postpones the next attempt by a full refresh window —
      // per-search retries against a down host would hammer it.
      this.#syncedAt = this.#now();
      this.#logger?.warn({ err: error }, "eicon index delta refresh failed");
    }
  }

  async #fullFetch(): Promise<void> {
    const text = await this.#fetchText(BASE_PATH);
    const { asOf, lines } = parseDoc(text);
    const names = lines
      .map((line) => line.split("\t")[0] ?? "")
      .filter((name) => name !== "");
    this.#adopt(names, asOf, this.#now());
    await this.#persist();
    this.#logger?.info({ count: names.length, asOf }, "eicon index downloaded");
  }

  async #deltaFetch(): Promise<void> {
    const text = await this.#fetchText(`${DELTA_PATH}${String(this.#asOf)}`);
    const { asOf, lines } = parseDoc(text);
    const names = new Map(
      this.#names.map((name) => [name.toLowerCase(), name]),
    );
    for (const line of lines) {
      const [action, name] = line.split("\t");
      if (!name) {
        continue;
      }
      if (action === "+") {
        names.set(name.toLowerCase(), name);
      } else if (action === "-") {
        names.delete(name.toLowerCase());
      }
    }
    this.#adopt([...names.values()], Math.max(asOf, this.#asOf), this.#now());
    await this.#persist();
    this.#logger?.info(
      { count: this.#names.length, applied: lines.length, asOf: this.#asOf },
      "eicon index delta applied",
    );
  }

  #adopt(names: string[], asOf: number, syncedAt: number): void {
    this.#names = names;
    this.#lowered = names.map((name) => name.toLowerCase());
    this.#asOf = asOf;
    this.#syncedAt = syncedAt;
  }

  async #persist(): Promise<void> {
    const payload: IndexPayload = { asOf: this.#asOf, names: this.#names };
    await this.#db
      .insert(flistMappings)
      .values({
        source: SOURCE,
        payload: payload as unknown as Record<string, unknown>,
        fetchedAt: new Date(this.#now()),
      })
      .onConflictDoUpdate({
        target: flistMappings.source,
        set: {
          payload: payload as unknown as Record<string, unknown>,
          fetchedAt: new Date(this.#now()),
        },
      });
  }

  async #fetchText(path: string): Promise<string> {
    const response = await fetch(`${this.#baseUrl}${path}`, {
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      throw new Error(`eicon index fetch failed (${String(response.status)})`);
    }
    return response.text();
  }
}

/** Split a base.doc/delta body: `# As Of: <unix>` comments + data lines. */
function parseDoc(text: string): { asOf: number; lines: string[] } {
  let asOf = 0;
  const lines: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trimEnd();
    if (line === "") {
      continue;
    }
    if (line.startsWith("#")) {
      const match = /as of:\s*(\d+)/i.exec(line);
      if (match) {
        asOf = Number(match[1]);
      }
      continue;
    }
    lines.push(line);
  }
  return { asOf, lines };
}
