// Campaign surface logic (M11 step 5, COMPONENTS-rotation-ratings.md §1–§4)
// — pure helpers behind CampaignDialog, unit-tested without React.

import type { AdDto, CampaignDto } from "@emberchat/protocol";
import { parseAdsCadence } from "./post-ads-logic.js";

/** What the status surface renders as its headline strip. */
export type CampaignPhase = "live" | "detached" | "stopped" | "expired";

export function campaignPhase(
  campaign: CampaignDto,
  now: number,
): CampaignPhase {
  if (campaign.stoppedAt !== undefined) {
    return "stopped";
  }
  if (now >= campaign.expiresAt) {
    return "expired";
  }
  return campaign.attached ? "live" : "detached";
}

/** "41:12" — minutes:seconds until the expiry (never negative). */
export function formatExpiry(expiresAt: number, now: number): string {
  const left = Math.max(0, expiresAt - now);
  const minutes = Math.floor(left / 60_000);
  const seconds = Math.floor((left % 60_000) / 1000);
  return `${String(minutes)}:${String(seconds).padStart(2, "0")}`;
}

/** Wall-clock "HH:MM" for a timeline stamp. */
export function formatClock(at: number): string {
  return new Date(at).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** "in 2m" / "in <1m" for the sub-line under a next-post stamp. */
export function formatIn(at: number, now: number): string {
  const minutes = Math.ceil((at - now) / 60_000);
  return minutes <= 0 ? "any moment" : `in ${String(minutes)}m`;
}

/** The per-row schedule fact (§1b): base window, or the channel's honored
 * request when its description asks for more. */
export function effectiveIntervalText(description: string): {
  text: string;
  honored: boolean;
} {
  const requested = parseAdsCadence(description);
  if (requested !== undefined && requested > 12) {
    return {
      text: `≈ one ad every ${String(requested)} min · honoring [ads: ${String(requested)} min]`,
      honored: true,
    };
  }
  return { text: "≈ one ad every 12–22 min", honored: false };
}

/** The status-row schedule fact (§3b) — a sentence, never the bracket
 * token syntax the setup rows may show. */
export function statusIntervalText(description: string): string {
  const requested = parseAdsCadence(description);
  if (requested !== undefined && requested > 12) {
    return `every ≈${String(requested)} min · honoring their request`;
  }
  return "every 12–22 min";
}

/** The rotation set a tag selection resolves to: enabled ads carrying any
 * selected tag, in library order (mirrors the server's cycle). */
export function resolveCycle(ads: AdDto[], tags: string[]): AdDto[] {
  const wanted = new Set(tags.map((tag) => tag.toLowerCase()));
  return ads.filter(
    (ad) =>
      !ad.disabled && ad.tags.some((tag) => wanted.has(tag.toLowerCase())),
  );
}

/** Elapsed fraction for the expiry bar's track (clamped 0–1). */
export function elapsedFraction(
  startedAt: number,
  expiresAt: number,
  now: number,
): number {
  const span = expiresAt - startedAt;
  if (span <= 0) {
    return 1;
  }
  return Math.min(1, Math.max(0, (now - startedAt) / span));
}

/** Headline counts for the live strip: "K active · J waiting · L stopped". */
export function channelCounts(campaign: CampaignDto): {
  active: number;
  waiting: number;
  stopped: number;
} {
  let active = 0;
  let waiting = 0;
  let stopped = 0;
  for (const channel of campaign.channels) {
    if (channel.state === "removed") {
      stopped += 1;
    } else if (channel.state === "active") {
      active += 1;
    } else {
      waiting += 1;
    }
  }
  return { active, waiting, stopped };
}

/** Total posts across the run (the expired summary's headline). */
export function totalPosts(campaign: CampaignDto): number {
  return campaign.channels.reduce((sum, channel) => sum + channel.posts, 0);
}
