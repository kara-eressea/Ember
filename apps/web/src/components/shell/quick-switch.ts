// Quick-switcher matching (M9 step 6): a small subsequence matcher — every
// query character must appear in order, case-insensitively. Scoring favors
// prefix matches, then word starts, then tighter spans; ties keep the
// caller's order (recent-first). Pure and unit-tested; no fuzzy library.

export interface SwitchCandidate {
  /** Stable id (conv id / identity id). */
  id: string;
  /** "channel" | "dm" | "identity" — the row glyph + route decide off it. */
  kind: "channel" | "dm" | "identity";
  label: string;
  /** Route target the caller navigates to on pick. */
  path: string;
}

export interface SwitchMatch extends SwitchCandidate {
  score: number;
}

/** Lower is better; undefined = no match. */
export function matchScore(query: string, label: string): number | undefined {
  const q = query.toLowerCase();
  const l = label.toLowerCase();
  if (q === "") {
    return 0;
  }
  let at = 0;
  let first = -1;
  for (const char of q) {
    const index = l.indexOf(char, at);
    if (index === -1) {
      return undefined;
    }
    if (first === -1) {
      first = index;
    }
    at = index + 1;
  }
  const span = at - first;
  const wordStart = first === 0 || l[first - 1] === " " ? 0 : 4;
  return first + wordStart + (span - q.length);
}

export function rankCandidates(
  query: string,
  candidates: SwitchCandidate[],
  limit = 12,
): SwitchMatch[] {
  const matches: SwitchMatch[] = [];
  for (const candidate of candidates) {
    const score = matchScore(query, candidate.label);
    if (score !== undefined) {
      matches.push({ ...candidate, score });
    }
  }
  // Stable sort: ties keep the incoming (recent-first) order.
  return matches.sort((a, b) => a.score - b.score).slice(0, limit);
}
