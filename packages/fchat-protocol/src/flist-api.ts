// Types for the F-List JSON API (design/chat-json-endpoints.md). Only the
// ticket endpoint is typed so far; the other endpoints arrive with the
// features that need them.
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

/** friend-list: account-wide pairs — dest is OUR character, source theirs. */
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
