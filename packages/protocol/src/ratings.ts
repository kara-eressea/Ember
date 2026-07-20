// M11 ad ratings (design/milestone-11-discovery-extras.md §2): the user's
// local ★1–5 + note on other posters. Per app user — one rating per rated
// character, shared across all the user's identities — and strictly
// local: nothing here ever reaches F-List. REST only (no gateway events;
// the acting device updates its own store, other devices converge on
// reload — ratings are low-churn personal annotations, not shared state).

import { z } from "zod";

export const MAX_RATING_NOTE_LENGTH = 500;

export const putRatingSchema = z.object({
  score: z.int().min(1).max(5),
  note: z.string().max(MAX_RATING_NOTE_LENGTH).optional(),
});

export interface RatingDto {
  /** The rated character, display case. */
  character: string;
  score: number;
  note?: string;
  /** ISO timestamp of the last edit. */
  updatedAt: string;
}
