// Profile DTOs (M8). The server resolves a raw character-data payload
// against the bulk mapping lists into this shape before it goes on the wire
// — numeric infotag/kink ids stay alongside the resolved names so the
// client-side matcher can key on ids, while the mapping bulk (hundreds of
// KB) never ships to clients.

import { z } from "zod";

/** A resolved infotag: list-type values already looked up via listitems. */
export const profileInfotagSchema = z.object({
  id: z.number(),
  label: z.string(),
  value: z.string(),
});

export const profileInfotagGroupSchema = z.object({
  group: z.string(),
  tags: z.array(profileInfotagSchema),
});

export const kinkChoiceSchema = z.enum(["fave", "yes", "maybe", "no"]);
export type KinkChoice = z.infer<typeof kinkChoiceSchema>;

export const profileKinkSchema = z.object({
  id: z.number(),
  name: z.string(),
  description: z.string(),
  choice: kinkChoiceSchema,
});

export const profileCustomKinkSchema = z.object({
  name: z.string(),
  description: z.string(),
  choice: z.string(),
  /** Standard kink ids grouped under this custom kink. */
  children: z.array(z.number()),
});

export const profileImageSchema = z.object({
  id: z.number(),
  /** Assembled static.f-list.net URL. */
  url: z.string(),
  width: z.number().nullable(),
  height: z.number().nullable(),
  description: z.string(),
});

/** A resolved inline image referenced by `[img]id[/img]` in the description
 * BBCode. Keyed by the inline id; the hash/extension are already assembled
 * into a static.f-list.net URL server-side. */
export const profileInlineSchema = z.object({
  url: z.string(),
});
export type ProfileInline = z.infer<typeof profileInlineSchema>;

export const profileDtoSchema = z.object({
  id: z.number(),
  name: z.string(),
  /** Raw BBCode in the profile dialect — rendered client-side. */
  description: z.string(),
  views: z.number(),
  customTitle: z.string().nullable(),
  customsFirst: z.boolean(),
  /** Unix seconds. */
  createdAt: z.number().nullable(),
  updatedAt: z.number().nullable(),
  settings: z.object({
    guestbook: z.boolean(),
    showFriends: z.boolean(),
    preventBookmarks: z.boolean(),
    public: z.boolean(),
  }),
  badges: z.array(z.string()),
  infotagGroups: z.array(profileInfotagGroupSchema),
  kinks: z.array(profileKinkSchema),
  customKinks: z.array(profileCustomKinkSchema),
  images: z.array(profileImageSchema),
  /** Inline images referenced by `[img]id[/img]` in `description`, keyed by
   * inline id. Empty when the profile uses none. */
  inlines: z.record(z.string(), profileInlineSchema),
  timezone: z.number().nullable(),
});
export type ProfileDto = z.infer<typeof profileDtoSchema>;

/** GET .../profile/:name response. `stale` = served past the cache TTL
 * (budget exhausted or upstream failure); the private note rides along so
 * the viewer paints in one request. */
export const profileResponseSchema = z.object({
  profile: profileDtoSchema,
  /** Unix ms. */
  fetchedAt: z.number(),
  stale: z.boolean(),
  budgetExhausted: z.boolean(),
  note: z.string().nullable(),
});
export type ProfileResponse = z.infer<typeof profileResponseSchema>;

export const profileHistoryEntrySchema = z.object({
  name: z.string(),
  /** Unix ms. */
  firstViewedAt: z.number(),
  lastViewedAt: z.number(),
  viewCount: z.number(),
});
export type ProfileHistoryEntry = z.infer<typeof profileHistoryEntrySchema>;

/** GET .../profile/:name/insights — relationship stats computed entirely
 * from data the bouncer already holds (messages, view history, live session
 * state). Zero F-List traffic. All-empty fields = "you haven't crossed
 * paths yet". */
export const profileInsightsSchema = z.object({
  /** DMs with this character, split by direction. */
  messagesSent: z.number(),
  messagesReceived: z.number(),
  /** Unix ms of the last DM either way; null = never chatted. */
  lastChattedAt: z.number().nullable(),
  /** First message we ever observed from them, any conversation. */
  firstEncountered: z
    .object({ at: z.number(), conversation: z.string() })
    .nullable(),
  /** Last message we observed from them, any conversation (unix ms). */
  lastSeenTalkingAt: z.number().nullable(),
  /** Live session state; false/empty when the identity is detached. */
  online: z.boolean(),
  status: z.string().nullable(),
  sharedChannels: z.array(z.string()),
  /** From the view-history row; zero/null before the first view lands. */
  timesViewed: z.number(),
  firstViewedAt: z.number().nullable(),
});
export type ProfileInsights = z.infer<typeof profileInsightsSchema>;

export const guestbookPageSchema = z.object({
  posts: z.array(
    z.object({
      id: z.number(),
      character: z.string(),
      /** Unix seconds, as upstream sends it. */
      postedAt: z.number().nullable(),
      message: z.string(),
      reply: z.string().nullable(),
    }),
  ),
  page: z.number(),
  nextPage: z.boolean(),
});
export type GuestbookPage = z.infer<typeof guestbookPageSchema>;
