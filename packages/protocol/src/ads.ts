// M10 ad library (design/milestone-10-ads-and-search.md): per-identity
// roleplay ads in the Horizon-faithful shape — content + tags + disabled,
// ordered by array position. Tags are purely local campaign selectors and
// channel targeting is chosen at post time, so neither ever needs more
// structure than this.

import { z } from "zod";

/** Ceiling on ads per identity — generous for a per-character library. */
export const MAX_ADS_PER_IDENTITY = 50;
export const MAX_AD_TAGS = 10;
export const MAX_AD_TAG_LENGTH = 30;
/** Editor-side ceiling, matching the documented lfrp_max; the live limit
 * is the lfrp_max VAR at post time, never this constant. */
export const MAX_AD_CONTENT_LENGTH = 50_000;

export const adInputSchema = z.object({
  /** Markdown; translated to BBCode at post time. */
  content: z.string().min(1).max(MAX_AD_CONTENT_LENGTH),
  /** Empty/whitespace tags are dropped server-side, not refused —
   * normalization (trim, dedupe, tagless → "default") is Horizon's save
   * behavior, and a sloppy client shouldn't 400 over it. */
  tags: z.array(z.string().max(MAX_AD_TAG_LENGTH)).max(MAX_AD_TAGS),
  disabled: z.boolean(),
});

export const putAdsSchema = z.object({
  /** The full library, in display order — a PUT replaces everything. */
  ads: z.array(adInputSchema).max(MAX_ADS_PER_IDENTITY),
  /** Compare-and-set: the ids this client last loaded. A mismatch means
   * another device edited the library since — 409, never a silent
   * clobber (the highlight-rules pattern). */
  knownIds: z.array(z.uuid()).max(MAX_ADS_PER_IDENTITY).optional(),
});

export interface AdDto {
  id: string;
  /** Markdown; translated to BBCode at post time. */
  content: string;
  tags: string[];
  disabled: boolean;
}
