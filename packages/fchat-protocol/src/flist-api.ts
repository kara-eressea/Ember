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
