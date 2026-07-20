// M11 ad-rotation campaigns (design/milestone-11-discovery-extras.md §1):
// one campaign per character — a tag set whose enabled ads cycle in library
// order across a chosen channel set, bounded by a 1-hour renewable expiry.
// The schedule itself (12-min floor, cadence floors, jitter, app-wide
// spacing) is server policy and never crosses the wire as configuration —
// clients only ever read the resulting timeline.

import { z } from "zod";
import { MAX_AD_TAGS, MAX_AD_TAG_LENGTH } from "./ads.js";

/** Campaign lifetime — a fixed fact, not a client-settable value. */
export const CAMPAIGN_DURATION_MS = 60 * 60 * 1000;
/** Ceiling on channels in one campaign (sanity bound, not a policy knob —
 * the real conservatism lever is the 1-hour expiry). */
export const MAX_CAMPAIGN_CHANNELS = 25;

export const campaignStartSchema = z.object({
  /** Tags whose enabled ads form the rotation set (union, deduped). */
  tags: z
    .array(z.string().min(1).max(MAX_AD_TAG_LENGTH))
    .min(1)
    .max(MAX_AD_TAGS),
  /** Channel keys to rotate into (joined ads/both channels). */
  channels: z
    .array(z.string().min(1).max(100))
    .min(1)
    .max(MAX_CAMPAIGN_CHANNELS),
  /** Required when a campaign is already running — the explicit
   * start-replaces-it confirmation; without it the server refuses. */
  replace: z.boolean().optional(),
});

/** One channel's place in the rotation. */
export type CampaignChannelState =
  /** Scheduled — `nextAt` says when it posts next. */
  | "active"
  /** Held (whole-campaign pause: no device attached). */
  | "waiting"
  /** The channel got an ad from elsewhere inside its window — paused
   * visibly, resumes on its own at `retryAt` (decided 2026-07-20). */
  | "refused"
  /** Kicked/banned — stopped permanently, never resumes. */
  | "removed";

export interface CampaignChannelDto {
  key: string;
  state: CampaignChannelState;
  /** Epoch ms of the next scheduled post (state "active"). */
  nextAt?: number;
  /** Epoch ms when a refused channel's window reopens. */
  retryAt?: number;
  /** Epoch ms of the last successful post. */
  lastAt?: number;
  /** Posts made into this channel this run. */
  posts: number;
}

export interface CampaignDto {
  id: string;
  tags: string[];
  /** Epoch ms. */
  startedAt: number;
  /** Epoch ms — the absolute bound; renewing moves it. */
  expiresAt: number;
  /** Epoch ms of an explicit stop (kill switch); unset while running or
   * merely expired. */
  stoppedAt?: number;
  /** False while no device is attached — the whole campaign is held and
   * every non-terminal channel reads as "waiting". */
  attached: boolean;
  channels: CampaignChannelDto[];
}

/** Running = not explicitly stopped and not past its expiry. */
export function campaignRunning(c: CampaignDto, now: number): boolean {
  return c.stoppedAt === undefined && now < c.expiresAt;
}
