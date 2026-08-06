// Shared upstream-call plumbing for routes that hit the F-List JSON API
// (social M6, profiles M8): ticket acquisition with one retry on refusal,
// and the mapping from upstream failures to HTTP statuses.

import {
  AccountLockedError,
  FlistApiBusyError,
  type SessionLogger,
  type SocialAuth,
  type TicketManagerRegistry,
} from "@emberchat/session-engine";

export interface TicketedIdentity {
  accountId: string;
  accountName: string;
}

/**
 * Runs an API call with the account's current ticket; on a ticket refusal,
 * invalidates and retries once with a fresh one. Tickets expire after 30
 * minutes while the manager caches for 25 — the overlap window plus an
 * account-wide invalidation elsewhere both land here.
 */
export async function withTicket<T extends { error: string }>(
  tickets: TicketManagerRegistry,
  identity: TicketedIdentity,
  call: (auth: SocialAuth) => Promise<T>,
): Promise<T> {
  const manager = tickets.managerFor(identity.accountId, identity.accountName);
  const auth = {
    account: identity.accountName,
    ticket: await manager.getTicket(),
  };
  const result = await call(auth);
  if (!/ticket/i.test(result.error)) {
    return result;
  }
  // Conditional: a LATE refusal for an old ticket must not evict a fresh
  // one another call already fetched (see TicketManager.invalidate).
  manager.invalidate(auth.ticket);
  return call({
    account: identity.accountName,
    ticket: await manager.getTicket(),
  });
}

/**
 * Rejections (as opposed to error envelopes) from the upstream path: a
 * memory-only vault after a restart throws AccountLockedError until the
 * user re-enters the password — the MOST likely production failure of these
 * routes, so it gets its own status instead of a bare 500 (M6 audit).
 * Busy = the shared 1 req/s budget shed the call.
 *
 * The two named arms carry text written for the user. Everything else is an
 * internal failure — a pg error, a zod parse of an upstream body, a raw
 * undici message — and its `message` is for the log, not for the browser:
 * echoing it verbatim disclosed internal hosts and ports. Hence the logger
 * being required rather than optional.
 */
export function upstreamStatus(
  error: unknown,
  log: SessionLogger,
): {
  code: 409 | 502 | 503;
  error: string;
} {
  if (error instanceof AccountLockedError) {
    return {
      code: 409,
      error:
        "The F-List account is locked (server restart) — unlock it from the identity screen",
    };
  }
  if (error instanceof FlistApiBusyError) {
    return { code: 503, error: error.message };
  }
  log.error({ err: error }, "upstream F-List call failed");
  return { code: 502, error: "F-List is unavailable right now — try again" };
}
