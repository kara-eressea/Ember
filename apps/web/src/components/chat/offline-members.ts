// "Seen recently" helpers (#200): the relative last-seen formatter, the
// shared member-filter matcher, and the per-channel collapse memory for the
// offline group. Pure and self-contained for unit testing; the MemberList
// renders off these.

import type { SeenMemberDto } from "@emberchat/protocol";

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

/** Newest-lastSeen-first, filtered by the active query (unfiltered when the
 * query is blank). Matching rows keep offline styling — sorting is the only
 * transform. */
export function offlineRows(
  seen: readonly SeenMemberDto[],
  query: string,
): SeenMemberDto[] {
  const rows = query.trim()
    ? seen.filter((entry) => matchesMemberQuery(entry.character, query))
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
