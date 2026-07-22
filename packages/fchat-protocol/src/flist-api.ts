// Types for the F-List JSON API (design/chat-json-endpoints.md — shapes below
// the "Verified shapes" divider were captured live on 2026-07-17).
//
// Operational constraints (developer policy): tickets are valid for 30
// minutes, each new ticket invalidates all previous tickets account-wide,
// and the endpoint budget is ≤ 1 request/second — all ticket acquisition
// must go through the per-account TicketManager.

import { z } from "zod";

/** POST target, relative to the F-List (or fchat-sim) base URL. */
export const API_TICKET_PATH = "/json/getApiTicket.php";

export const apiTicketSuccessSchema = z.object({
  error: z.literal(""),
  ticket: z.string(),
  // Omitted when the request passes no_characters / no_friends / no_bookmarks.
  characters: z.array(z.string()).optional(),
  default_character: z.string().optional(),
  friends: z
    .array(z.object({ source_name: z.string(), dest_name: z.string() }))
    .optional(),
  bookmarks: z.array(z.object({ name: z.string() })).optional(),
});

export const apiTicketFailureSchema = z.object({
  error: z.string().min(1),
});

export const apiTicketResponseSchema = z.union([
  apiTicketSuccessSchema,
  apiTicketFailureSchema,
]);

export type ApiTicketSuccess = z.infer<typeof apiTicketSuccessSchema>;
export type ApiTicketFailure = z.infer<typeof apiTicketFailureSchema>;
export type ApiTicketResponse = z.infer<typeof apiTicketResponseSchema>;

// ── Social endpoints (M6 step 7) ─────────────────────────────────────────────
// All POST with account+ticket form fields; every response carries the
// {"error": ""} envelope. Shapes are lenient — F-List's exact payloads are
// under-documented, so unknown extras must never break parsing.

/** Relative POST paths for the social endpoints. */
export const SOCIAL_API_PATHS = {
  bookmarkList: "/json/api/bookmark-list.php",
  bookmarkAdd: "/json/api/bookmark-add.php",
  bookmarkRemove: "/json/api/bookmark-remove.php",
  friendList: "/json/api/friend-list.php",
  friendRemove: "/json/api/friend-remove.php",
  requestList: "/json/api/request-list.php",
  requestPending: "/json/api/request-pending.php",
  requestSend: "/json/api/request-send.php",
  requestAccept: "/json/api/request-accept.php",
  requestDeny: "/json/api/request-deny.php",
  requestCancel: "/json/api/request-cancel.php",
} as const;

/** The bare success/failure envelope (mutating endpoints). */
export const apiEnvelopeSchema = z.object({ error: z.string() });
export type ApiEnvelope = z.infer<typeof apiEnvelopeSchema>;

/** bookmark-list: account-wide bookmarked profile names. */
export const bookmarkListSchema = z.object({
  error: z.string(),
  characters: z.array(z.string()).optional(),
});
export type BookmarkList = z.infer<typeof bookmarkListSchema>;

/** friend-list: account-wide pairs — source is OUR character, dest the
 * friend (same orientation as friend-remove's source_name/dest_name). */
export const friendListSchema = z.object({
  error: z.string(),
  friends: z
    .array(
      z.object({
        source: z.string(),
        dest: z.string(),
        last_online: z.number().optional(),
      }),
    )
    .optional(),
});
export type FriendList = z.infer<typeof friendListSchema>;

/** request-list (incoming) / request-pending (outgoing): friend requests.
 * source is the sender, dest the recipient; id feeds accept/deny/cancel. */
export const friendRequestListSchema = z.object({
  error: z.string(),
  requests: z
    .array(
      z.object({
        id: z.number(),
        source: z.string(),
        dest: z.string(),
      }),
    )
    .optional(),
});
export type FriendRequestList = z.infer<typeof friendRequestListSchema>;

// ── Character-data endpoints (M8 step 2) ─────────────────────────────────────
// Verified live 2026-07-17 (chat-json-endpoints.md "Verified shapes"). Two
// cross-endpoint quirks the schemas encode: numbers arrive string-typed in
// some payloads and numeric in others (z.coerce throughout), and failures are
// HTTP 200 with a non-empty `error` and the payload fields absent (payload
// fields optional, callers check `error` first). character-data requests are
// additionally metered by the server's CharacterDataBudget (170/hour soft
// cap under F-List's 200/hour limit).

/** Relative POST paths for the character endpoints. */
export const CHARACTER_API_PATHS = {
  characterData: "/json/api/character-data.php",
  // mapping-list supersedes kink-list/info-list (same data, regrouped);
  // all three are ticketless.
  mappingList: "/json/api/mapping-list.php",
  kinkList: "/json/api/kink-list.php",
  infoList: "/json/api/info-list.php",
  guestbook: "/json/api/character-guestbook.php",
  memoGet: "/json/api/character-memo-get2.php",
} as const;

/** character-data images: all values string-typed, no URL — assemble
 * `https://static.f-list.net/images/charimage/{image_id}.{extension}`. */
export const characterImageSchema = z.object({
  image_id: z.coerce.number(),
  extension: z.string(),
  height: z.coerce.number().optional(),
  width: z.coerce.number().optional(),
  description: z.string().optional(),
  sort_order: z.coerce.number().optional(),
});
export type CharacterImage = z.infer<typeof characterImageSchema>;

/** character-data inline images: the map `[img]` references by id. The
 * assembled URL is
 * `https://static.f-list.net/images/charinline/{hash 0-1}/{hash 2-3}/{hash}.{extension}`.
 * `nyan` is a rating/flags field the client doesn't need. */
export const characterInlineSchema = z.object({
  hash: z.string(),
  extension: z.string(),
  nyan: z.coerce.number().optional(),
});
export type CharacterInline = z.infer<typeof characterInlineSchema>;

export const customKinkSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  /** fave | yes | maybe | no — left open for drift. */
  choice: z.string().optional(),
  /** Standard kink ids grouped under this custom kink. */
  children: z.array(z.coerce.number()).optional(),
});
export type CustomKink = z.infer<typeof customKinkSchema>;

/** PHP serializes an empty associative array as `[]` — the JSON API sends
 * record-shaped fields as an empty array when they hold nothing. Accept
 * that and normalize to an empty record. */
function phpRecord<V extends z.ZodType>(value: V) {
  return z.preprocess(
    (input) => (Array.isArray(input) && input.length === 0 ? {} : input),
    z.record(z.string(), value),
  );
}

export const characterDataSchema = z.object({
  error: z.string(),
  id: z.coerce.number().optional(),
  name: z.string().optional(),
  /** Raw BBCode in the profile dialect (wider than the chat subset). */
  description: z.string().optional(),
  views: z.coerce.number().optional(),
  customs_first: z.boolean().optional(),
  custom_title: z.string().nullable().optional(),
  is_self: z.boolean().optional(),
  /** `settings.guestbook` gates the Guestbook tab without spending budget. */
  settings: z
    .object({
      customs_first: z.boolean().optional(),
      show_friends: z.boolean().optional(),
      guestbook: z.boolean().optional(),
      prevent_bookmarks: z.boolean().optional(),
      public: z.boolean().optional(),
    })
    .optional(),
  badges: z.array(z.string()).optional(),
  created_at: z.coerce.number().optional(),
  updated_at: z.coerce.number().optional(),
  /** kink id (string key) → "fave" | "yes" | "maybe" | "no". */
  kinks: phpRecord(z.string()).optional(),
  custom_kinks: phpRecord(customKinkSchema).optional(),
  /** infotag id (string key) → listitem id for list-type tags, free text
   * otherwise; resolve via mapping-list. */
  infotags: phpRecord(z.string()).optional(),
  /** inline id (string key) → { hash, extension } for `[img]` in the
   * description. */
  inlines: phpRecord(characterInlineSchema).optional(),
  images: z.array(characterImageSchema).optional(),
  timezone: z.coerce.number().nullable().optional(),
});
export type CharacterData = z.infer<typeof characterDataSchema>;

/** mapping-list: the one bulk payload profile resolution actually needs —
 * every value string-typed on the wire. */
export const mappingListSchema = z.object({
  error: z.string(),
  kinks: z
    .array(
      z.object({
        id: z.coerce.number(),
        name: z.string(),
        description: z.string().optional(),
        group_id: z.coerce.number(),
      }),
    )
    .optional(),
  kink_groups: z
    .array(z.object({ id: z.coerce.number(), name: z.string() }))
    .optional(),
  infotags: z
    .array(
      z.object({
        id: z.coerce.number(),
        name: z.string(),
        /** "text" | "list" — list values resolve through `listitems`. */
        type: z.string(),
        /** Listitem family name for list-type tags ("orientation", …). */
        list: z.string().optional(),
        group_id: z.coerce.number(),
      }),
    )
    .optional(),
  infotag_groups: z
    .array(z.object({ id: z.coerce.number(), name: z.string() }))
    .optional(),
  listitems: z
    .array(
      z.object({
        id: z.coerce.number(),
        name: z.string(),
        value: z.string(),
      }),
    )
    .optional(),
});
export type MappingList = z.infer<typeof mappingListSchema>;

/** kink-list: kinks grouped by group id; HTML entities in group names. */
export const kinkListSchema = z.object({
  error: z.string(),
  kinks: phpRecord(
    z.object({
      group: z.string(),
      items: z.array(
        z.object({
          kink_id: z.coerce.number(),
          name: z.string(),
          description: z.string().optional(),
        }),
      ),
    }),
  ).optional(),
});
export type KinkList = z.infer<typeof kinkListSchema>;

/** info-list: infotags grouped by group id; dropdown items carry options. */
export const infoListSchema = z.object({
  error: z.string(),
  info: phpRecord(
    z.object({
      group: z.string(),
      items: z.array(
        z.object({
          id: z.coerce.number(),
          name: z.string(),
          type: z.string(),
          list: z.array(z.string()).optional(),
        }),
      ),
    }),
  ).optional(),
});
export type InfoList = z.infer<typeof infoListSchema>;

/** Observed guestbook post; `repliedAt`/`deleted` appear in client sources
 * but not in the live sample (likely reply-dependent) — kept optional. */
export const guestbookPostSchema = z.object({
  id: z.coerce.number(),
  character: z.object({ id: z.coerce.number(), name: z.string() }),
  /** Unix seconds. */
  postedAt: z.coerce.number().optional(),
  message: z.string().optional(),
  reply: z.string().nullable().optional(),
  repliedAt: z.coerce.number().nullable().optional(),
  private: z.boolean().optional(),
  approved: z.boolean().optional(),
  canEdit: z.boolean().optional(),
  deleted: z.boolean().optional(),
});
export type GuestbookPost = z.infer<typeof guestbookPostSchema>;

/** character-guestbook: 0-based `page`, pages of 10. A disabled guestbook is
 * the error case ("This character does not have a guestbook."). */
export const guestbookSchema = z.object({
  error: z.string(),
  posts: z.array(guestbookPostSchema).optional(),
  page: z.coerce.number().optional(),
  canEdit: z.boolean().optional(),
  nextPage: z.boolean().optional(),
});
export type Guestbook = z.infer<typeof guestbookSchema>;

/** character-memo-get2: `note` is null when no memo exists; `id` is the save
 * target for character-memo-save.php — treat as opaque and echo back. */
export const memoGetSchema = z.object({
  error: z.string(),
  note: z.string().nullable().optional(),
  id: z.coerce.number().optional(),
});
export type MemoGet = z.infer<typeof memoGetSchema>;
