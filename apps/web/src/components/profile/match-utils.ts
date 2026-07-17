// Presentation helpers over a MatchReport: which dimension chips deserve
// the limited space on the mini card / MatchStrip, and the compare header's
// one-line summary. Pure — unit-tested without React.

import {
  TIER_FRACTION,
  type MatchReport,
  type MatchTier,
} from "@emberchat/matcher";

export interface NotableDimension {
  label: string;
  tier: MatchTier;
  reason: string;
}

/** The most informative chips, extremes first (distance from neutral),
 * conflicts breaking ties — neutral rows say nothing and never show. The
 * kink aggregate joins as a pseudo-dimension when any kinks overlap. */
export function notableDimensions(
  report: MatchReport,
  limit: number,
): NotableDimension[] {
  const candidates: NotableDimension[] = report.dimensions.map((dimension) => ({
    label: dimension.label,
    tier: dimension.tier,
    reason: dimension.reason,
  }));
  if (report.kinks.length > 0) {
    candidates.push({
      label: "Kinks",
      tier: report.kinkOverall,
      reason: `${String(report.kinks.length)} kinks on both lists`,
    });
  }
  return candidates
    .filter((candidate) => candidate.tier !== "neutral")
    .sort(
      (a, b) =>
        Math.abs(TIER_FRACTION[b.tier] - 0.5) -
          Math.abs(TIER_FRACTION[a.tier] - 0.5) ||
        TIER_FRACTION[a.tier] - TIER_FRACTION[b.tier],
    )
    .slice(0, limit);
}

/** One-line verdict under the compare header (§9). */
export function compareSummary(report: MatchReport, them: string): string {
  const conflicts = report.dimensions.filter(
    (dimension) =>
      dimension.tier === "mismatch" || dimension.tier === "weakMismatch",
  ).length;
  switch (report.overall) {
    case "match":
      return `Strongly compatible — your profile and ${them}'s line up across the board.`;
    case "weakMatch":
      return conflicts > 0
        ? `Broadly compatible, with ${String(conflicts)} point${conflicts === 1 ? "" : "s"} of friction below.`
        : "Broadly compatible, with minor caveats.";
    case "neutral":
      return "Not enough overlapping profile data for a verdict yet.";
    case "weakMismatch":
      return "Some friction — the conflicts below outweigh the matches.";
    case "mismatch":
      return `A hard conflict — at least one dimension of ${them}'s profile clashes with yours.`;
  }
}
