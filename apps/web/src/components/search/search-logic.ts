// Pure logic behind the character-search dialog (M10 step 9): the FKS
// filter vocabularies (documented enum names — display labels ARE the wire
// values), saved-search plumbing, and the per-device "N new" diff against
// the last run's name set.

import type { UserPrefs } from "@emberchat/protocol";

export type SavedSearch = UserPrefs["savedSearches"][number];

export interface SearchFilters {
  kinks: string[];
  genders?: string[];
  orientations?: string[];
  languages?: string[];
  furryprefs?: string[];
  roles?: string[];
}

/** The documented FKS enum vocabularies (design/client-commands.md). The
 * wire wants these exact strings, so they double as display labels. */
export const GENDERS = [
  "Male",
  "Female",
  "Transgender",
  "Herm",
  "Shemale",
  "Male-Herm",
  "Cunt-boy",
  "None",
] as const;

export const ORIENTATIONS = [
  "Straight",
  "Gay",
  "Bisexual",
  "Asexual",
  "Unsure",
  "Bi - male preference",
  "Bi - female preference",
  "Pansexual",
  "Bi-curious",
] as const;

export const LANGUAGES = [
  "English",
  "Dutch",
  "French",
  "Spanish",
  "German",
  "Russian",
  "Chinese",
  "Japanese",
  "Portuguese",
  "Korean",
  "Arabic",
  "Italian",
  "Swedish",
  "Other",
] as const;

export const FURRYPREFS = [
  "No furry characters, just humans",
  "No humans, just furry characters",
  "Furries ok, Humans Preferred",
  "Humans ok, Furries Preferred",
  "Furs and / or humans",
] as const;

export const ROLES = [
  "Always dominant",
  "Usually dominant",
  "Switch",
  "Usually submissive",
  "Always submissive",
  "None",
] as const;

/** Short display labels where the wire string is a mouthful. */
export const FURRYPREF_LABELS: Record<string, string> = {
  "No furry characters, just humans": "Human only",
  "No humans, just furry characters": "Furs only",
  "Furries ok, Humans Preferred": "Furries ok",
  "Humans ok, Furries Preferred": "Furry pref",
  "Furs and / or humans": "Either",
};

/** Drops empty filter arrays so the wire only carries real narrowing. */
export function normalizeFilters(filters: SearchFilters): SearchFilters {
  const out: SearchFilters = { kinks: filters.kinks };
  for (const key of [
    "genders",
    "orientations",
    "languages",
    "furryprefs",
    "roles",
  ] as const) {
    const values = filters[key];
    if (values !== undefined && values.length > 0) {
      out[key] = values;
    }
  }
  return out;
}

/** Case-insensitive client-side name filter — the wire has no text search,
 * so the box narrows the returned names locally. */
export function filterNames(names: string[], query: string): string[] {
  const q = query.trim().toLowerCase();
  if (q === "") {
    return names;
  }
  return names.filter((name) => name.toLowerCase().includes(q));
}

/** Names in `current` that were absent from the previous run — the "N new"
 * badge. Case-insensitive: the wire's casing is canonical but stable. */
export function newSince(previous: string[], current: string[]): number {
  const seen = new Set(previous.map((name) => name.toLowerCase()));
  return current.filter((name) => !seen.has(name.toLowerCase())).length;
}

const RUNS_KEY_PREFIX = "emberchat.searchRun.";
/** Cap the stored name set — beyond this a diff is noise anyway. */
const RUN_NAMES_CAP = 500;

export interface SearchRun {
  at: string;
  names: string[];
}

/** Last run of a saved search on THIS device (localStorage — result sets
 * are too heavy for the synced prefs document). */
export function loadRun(searchId: string): SearchRun | undefined {
  try {
    const raw = localStorage.getItem(RUNS_KEY_PREFIX + searchId);
    if (raw === null) {
      return undefined;
    }
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      Array.isArray((parsed as SearchRun).names)
    ) {
      return parsed as SearchRun;
    }
  } catch {
    // Corrupt or unavailable storage — no previous run then.
  }
  return undefined;
}

export function saveRun(searchId: string, names: string[]): void {
  try {
    localStorage.setItem(
      RUNS_KEY_PREFIX + searchId,
      JSON.stringify({
        at: new Date().toISOString(),
        names: names.slice(0, RUN_NAMES_CAP),
      } satisfies SearchRun),
    );
  } catch {
    // Storage full/unavailable — the badge just won't diff on this device.
  }
}

export function dropRun(searchId: string): void {
  try {
    localStorage.removeItem(RUNS_KEY_PREFIX + searchId);
  } catch {
    // Nothing to clean.
  }
}

/** Filters of a saved search, ready to fire. */
export function filtersOf(saved: SavedSearch): SearchFilters {
  return normalizeFilters({
    kinks: saved.kinks,
    genders: saved.genders,
    orientations: saved.orientations,
    languages: saved.languages,
    furryprefs: saved.furryprefs,
    roles: saved.roles,
  });
}

/** "6 kinks · 2 filters" — the saved-row meta line. */
export function savedMeta(saved: SavedSearch): string {
  const filterCount = [
    saved.genders,
    saved.orientations,
    saved.languages,
    saved.furryprefs,
    saved.roles,
  ].filter((values) => values !== undefined && values.length > 0).length;
  const kinks = `${String(saved.kinks.length)} ${saved.kinks.length === 1 ? "kink" : "kinks"}`;
  return filterCount > 0
    ? `${kinks} · ${String(filterCount)} ${filterCount === 1 ? "filter" : "filters"}`
    : kinks;
}
