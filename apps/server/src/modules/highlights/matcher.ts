// Highlight matcher (M5) — the single authoritative mention engine. The
// history sink consults it at persist time to stamp `messages.mention`;
// snapshots, badge totals and the client's live bump all read the stored
// flag, so no second matcher exists anywhere (which retires the M2 note
// about keeping the SQL and JS engines byte-identical).
//
// Patterns run on RE2: linear-time by construction, so a user-authored
// regex can never become a catastrophic-backtracking DoS against the shared
// sink (decisions.md §10). Rules and the own-nick preference are cached per
// user; the REST PUT and `prefs.set` invalidate.

import RE2 from "re2";
import { eq } from "drizzle-orm";
import { resolvePrefs, type HighlightRuleKind } from "@emberchat/protocol";
import type { Db } from "../../db/index.js";
import {
  flistAccounts,
  highlightRules,
  identities,
  userPreferences,
} from "../../db/schema.js";
import type { SessionLogger } from "../session-engine/fchat-session.js";

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * ASCII word-boundary wrap — explicit classes, not \b: they work for terms
 * with leading/trailing hyphens (which have no \b boundary at all) and keep
 * the semantics of the retired M2 SQL matcher. "Amber Vale" still never
 * matches inside "Amber Valery".
 */
function boundaryPattern(term: string): string {
  return `(^|[^a-zA-Z0-9_])${escapeRegex(term)}([^a-zA-Z0-9_]|$)`;
}

/**
 * Compile one rule. `word`/`nick` are literal terms matched at word
 * boundaries; `regex` runs as written. Case-insensitive throughout. Throws
 * on a pattern RE2 refuses — the PUT route turns that into a 422.
 */
export function compileRule(kind: HighlightRuleKind, pattern: string): RE2 {
  return kind === "regex"
    ? new RE2(pattern, "i")
    : new RE2(boundaryPattern(pattern), "i");
}

export class HighlightMatcher {
  readonly #db: Db;
  readonly #log: SessionLogger | undefined;
  readonly #rulesByUser = new Map<string, RE2[]>();
  readonly #ownNickByUser = new Map<string, boolean>();
  /** identity → user is immutable (identities never move accounts). */
  readonly #userByIdentity = new Map<string, string>();
  readonly #nickRegexes = new Map<string, RE2>();

  constructor(db: Db, log?: SessionLogger) {
    this.#db = db;
    this.#log = log;
  }

  /**
   * Persist-time verdict for an inbound channel message. Never throws — a
   * matcher failure must degrade to "no mention", not take the history
   * write down with it.
   */
  async mention(
    identityId: string,
    character: string,
    text: string,
  ): Promise<boolean> {
    try {
      const userId = await this.#userId(identityId);
      if (userId === undefined) {
        return false;
      }
      if (
        (await this.#ownNick(userId)) &&
        this.#nickRegex(character).test(text)
      ) {
        return true;
      }
      return (await this.#rules(userId)).some((rule) => rule.test(text));
    } catch (error) {
      this.#log?.error({ err: error }, "highlight matcher failed");
      return false;
    }
  }

  /** Drop cached rules + prefs after a rules PUT or a prefs patch. */
  invalidate(userId: string): void {
    this.#rulesByUser.delete(userId);
    this.#ownNickByUser.delete(userId);
  }

  async #userId(identityId: string): Promise<string | undefined> {
    const cached = this.#userByIdentity.get(identityId);
    if (cached !== undefined) {
      return cached;
    }
    const [row] = await this.#db
      .select({ userId: flistAccounts.userId })
      .from(identities)
      .innerJoin(flistAccounts, eq(identities.flistAccountId, flistAccounts.id))
      .where(eq(identities.id, identityId))
      .limit(1);
    if (row) {
      this.#userByIdentity.set(identityId, row.userId);
    }
    return row?.userId;
  }

  async #ownNick(userId: string): Promise<boolean> {
    const cached = this.#ownNickByUser.get(userId);
    if (cached !== undefined) {
      return cached;
    }
    const [row] = await this.#db
      .select({ prefs: userPreferences.prefs })
      .from(userPreferences)
      .where(eq(userPreferences.userId, userId))
      .limit(1);
    const value = resolvePrefs(row?.prefs).highlightOwnNick;
    this.#ownNickByUser.set(userId, value);
    return value;
  }

  async #rules(userId: string): Promise<RE2[]> {
    const cached = this.#rulesByUser.get(userId);
    if (cached !== undefined) {
      return cached;
    }
    const rows = await this.#db
      .select({ kind: highlightRules.kind, pattern: highlightRules.pattern })
      .from(highlightRules)
      .where(eq(highlightRules.userId, userId));
    const compiled: RE2[] = [];
    for (const row of rows) {
      // Stored rows were PUT-validated, so this only fires if RE2's parser
      // changed underneath us — skip the row rather than lose the message.
      try {
        compiled.push(compileRule(row.kind, row.pattern));
      } catch (error) {
        this.#log?.warn(
          { err: error, pattern: row.pattern },
          "stored highlight rule no longer compiles",
        );
      }
    }
    this.#rulesByUser.set(userId, compiled);
    return compiled;
  }

  #nickRegex(character: string): RE2 {
    const key = character.toLowerCase();
    const cached = this.#nickRegexes.get(key);
    if (cached !== undefined) {
      return cached;
    }
    const regex = new RE2(boundaryPattern(character), "i");
    this.#nickRegexes.set(key, regex);
    return regex;
  }
}
