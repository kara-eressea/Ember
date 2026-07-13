// Pure derivations for the IdentityRail (COMPONENTS.md §1) — kept out of the
// component so badge/presence semantics are unit-testable.

import type { GatewaySessionStatus } from "@emberchat/protocol";
import type { DotKind } from "../../lib/presence.js";
import type {
  IdentitySession,
  IdentitySummary,
} from "../../stores/sessions.js";

export interface RailBadge {
  unread: number;
  mentions: number;
}

/**
 * Badge totals for one rail item. A synced slice aggregates its live
 * per-conversation counters (they follow message.new bumps and read-cursor
 * convergence); an unsynced identity falls back to the ready-frame totals —
 * that is all we know about it until it is subscribed.
 */
export function railBadge(
  summary: IdentitySummary,
  slice: IdentitySession | undefined,
): RailBadge {
  if (!slice?.synced) {
    return { unread: summary.unread, mentions: summary.mentions };
  }
  let unread = 0;
  let mentions = 0;
  for (const channel of Object.values(slice.channels)) {
    unread += channel.unread;
    mentions += channel.mentions;
  }
  for (const dm of Object.values(slice.dms)) {
    unread += dm.unread;
  }
  return { unread, mentions };
}

/** Presence dot for a rail item: our own session's lifecycle state. */
export function railDot(status: GatewaySessionStatus): DotKind {
  if (status === "online") {
    return "ok";
  }
  if (status === "offline" || status === "stopped") {
    return "faint";
  }
  // idle / acquiring_ticket / connecting / identifying / backoff — in flight.
  return "warn";
}
