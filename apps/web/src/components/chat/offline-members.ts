// "Seen recently" helpers (#200): the relative last-seen formatter, the
// shared member-filter matcher, and the per-channel collapse memory for the
// offline group. Pure and self-contained for unit testing; the MemberList
// renders off these.

import type { SeenMemberDto } from "@emberchat/protocol";
import { decodeWireEntities } from "../../lib/wire-text.js";

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/**
 * Plain-language relative last-seen time (spec §2): "just now" under two
 * minutes, then minutes, hours, "yesterday", days. No clock times, no
 * dates, no seconds — retention (~1 week) bounds the oldest value.
 */
export function relativeSeen(lastSeen: number, now: number): string {
  const age = Math.max(0, now - lastSeen);
  if (age < 2 * MINUTE_MS) {
    return "just now";
  }
  if (age < HOUR_MS) {
    return `${String(Math.floor(age / MINUTE_MS))} min ago`;
  }
  if (age < DAY_MS) {
    return `${String(Math.floor(age / HOUR_MS))} hr ago`;
  }
  const days = Math.floor(age / DAY_MS);
  return days === 1 ? "yesterday" : `${String(days)} days ago`;
}

/** One nick-substring matcher for every group, case-insensitive (spec §4). */
export function matchesMemberQuery(character: string, query: string): boolean {
  return character.toLowerCase().includes(query.trim().toLowerCase());
}

/** Everything the client already holds about a member without asking the
 * network — a roster entry (all four) or a "Seen recently" entry (the first
 * two). #497 is explicit that a keystroke never triggers a profile fetch, so
 * species/orientation and the rest stay out until they arrive for free.  */
export interface MemberMatchFields {
  character: string;
  gender?: string;
  status?: string;
  statusmsg?: string;
}

/** F-Chat's default status carries no signal — every member is "online" — so
 * matching it would turn a query like "o" into "show the entire roster". The
 * chosen states (looking/away/busy/dnd/idle/crown) do carry signal. */
const UNINFORMATIVE_STATUS = new Set(["", "online"]);

/**
 * The member-list Find matcher (#497): the nick, plus the profile facts every
 * row already carries.
 *
 * Semantics, deliberately not uniform:
 *
 * - **Nick** — case-insensitive *substring*, as it always was.
 * - **Gender and status** — case-insensitive *word prefix*, never a bare
 *   substring. "male" is a substring of "female" and "shemale", so a
 *   substring rule would make the single most obvious gender query useless:
 *   typing "male" would return every female character too. Words split on
 *   spaces and hyphens, so "Male-Herm" answers to "male", "herm" and
 *   "male-h", and "Cunt-boy" to "boy" — while "female" answers only to "f…"
 *   through "female".
 * - **Status message** — case-insensitive substring of its *visible* text,
 *   so a query can't match BBCode syntax the row doesn't show ("red" must
 *   not match `[color=red]`). It is the one field whose match the row can
 *   already display, which is what makes it the least surprising of the
 *   three.
 *
 * Any single field matching is enough; a blank query matches everything.
 */
export function matchesMemberFilter(
  member: MemberMatchFields,
  query: string,
): boolean {
  const needle = query.trim().toLowerCase();
  if (needle === "") {
    return true;
  }
  if (matchesMemberQuery(member.character, needle)) {
    return true;
  }
  if (matchesWordPrefix(member.gender, needle)) {
    return true;
  }
  const status = member.status?.toLowerCase() ?? "";
  if (!UNINFORMATIVE_STATUS.has(status) && matchesWordPrefix(status, needle)) {
    return true;
  }
  return (
    member.statusmsg !== undefined &&
    statusText(member.statusmsg).includes(needle)
  );
}

/** `needle` is a prefix of `value` or of one of its hyphen/space-separated
 * words. Prefix, not substring — see the male/female note above. */
function matchesWordPrefix(value: string | undefined, needle: string): boolean {
  if (value === undefined || value === "") {
    return false;
  }
  const lower = value.toLowerCase();
  return (
    lower.startsWith(needle) ||
    lower.split(/[\s-]+/).some((word) => word.startsWith(needle))
  );
}

/** The visible text of a status message, lowercased. A deliberately cheap
 * tag strip rather than a BBCode parse: this runs over every member of the
 * roster on every keystroke, and all it has to answer is whether the words
 * the row shows contain the query. */
function statusText(statusmsg: string): string {
  return decodeWireEntities(
    statusmsg.replace(/\[[^\]]*\]/g, " "),
  ).toLowerCase();
}

/** Newest-lastSeen-first, filtered by the active query (unfiltered when the
 * query is blank). One matcher for every group (#497): a seen entry carries
 * its part-time gender, so "female" finds absent members too. Matching rows
 * keep offline styling — sorting is the only transform. */
export function offlineRows(
  seen: readonly SeenMemberDto[],
  query: string,
): SeenMemberDto[] {
  const rows = query.trim()
    ? seen.filter((entry) => matchesMemberFilter(entry, query))
    : [...seen];
  return rows.sort((a, b) => b.lastSeen - a.lastSeen);
}

// ── Per-channel collapse memory ──────────────────────────────────────────────
// Collapsed by default (spec §1); only the channels the user expanded are
// stored, so the default costs nothing. localStorage keeps the choice per
// browser across sessions; failures (private mode, quota) fall back to the
// default silently.

const EXPANDED_STORAGE_KEY = "eb.seenRecentlyExpanded";

function readExpanded(): string[] {
  try {
    const raw = localStorage.getItem(EXPANDED_STORAGE_KEY);
    const parsed: unknown = raw === null ? [] : JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((key): key is string => typeof key === "string")
      : [];
  } catch {
    return [];
  }
}

export function isOfflineExpanded(channelKey: string): boolean {
  return readExpanded().includes(channelKey);
}

export function setOfflineExpanded(
  channelKey: string,
  expanded: boolean,
): void {
  const keys = readExpanded().filter((key) => key !== channelKey);
  if (expanded) {
    keys.push(channelKey);
  }
  try {
    localStorage.setItem(EXPANDED_STORAGE_KEY, JSON.stringify(keys));
  } catch {
    // Remembering the fold is best-effort.
  }
}
