// Pure logic behind the Post Ads dialog (M10 step 6) — tag filtering,
// channel eligibility, the community cadence convention and cooldown
// formatting, unit-testable without a DOM.

import type { AdDto } from "@emberchat/protocol";

/** Parsed `[ads: N min]` from a channel description — a community
 * convention for the channel's requested ad cadence. Displayed so the
 * user can honor it; never enforced in M10. */
export function parseAdsCadence(description: string): number | undefined {
  const match = /\[ads:\s*(\d{1,4})\s*min(?:ute)?s?\]/i.exec(description);
  if (!match) {
    return undefined;
  }
  const minutes = Number(match[1]);
  return minutes > 0 ? minutes : undefined;
}

/** Tag chips for the filter row: every tag on an enabled ad with its ad
 * count, alphabetical, with an "all" chip up front carrying the total. */
export function tagCounts(ads: AdDto[]): { tag: string; count: number }[] {
  const enabled = ads.filter((ad) => !ad.disabled);
  const counts = new Map<string, number>();
  for (const ad of enabled) {
    for (const tag of ad.tags) {
      counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
  }
  return [
    { tag: "all", count: enabled.length },
    ...[...counts.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([tag, count]) => ({ tag, count })),
  ];
}

/** Enabled ads matching the tag filter ("all" = no filter). Returned as
 * [libraryIndex, ad] pairs so selection survives filtering. */
export function filterAds(
  ads: AdDto[],
  tag: string,
): { index: number; ad: AdDto }[] {
  return ads
    .map((ad, index) => ({ index, ad }))
    .filter(({ ad }) => !ad.disabled)
    .filter(({ ad }) => tag === "all" || ad.tags.includes(tag));
}

/** "3m" / "45s" — the remaining-cooldown chip. Rounds up so the copy
 * never claims a channel is clear before the server agrees. */
export function formatWait(ms: number): string {
  if (ms >= 60_000) {
    return `${String(Math.ceil(ms / 60_000))}m`;
  }
  return `${String(Math.max(1, Math.ceil(ms / 1000)))}s`;
}

export interface PostOutcome {
  key: string;
  title: string;
  ok: boolean;
  /** Friendly error copy when refused. */
  reason?: string;
  /** HH:MM local, when sent. */
  at?: string;
}
