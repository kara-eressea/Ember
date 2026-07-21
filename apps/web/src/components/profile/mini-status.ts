// The mini profile card shows a character's current status message when one
// is set (issue #201). There is no global presence roster in the store, so we
// derive it from the session's live sources — the same STA-fed data the member
// list, DM rows, and social lists render — preferring whichever source has a
// non-empty message. Own character falls back to the session's own STA.

import type { IdentitySession } from "../../stores/sessions.js";

function sameName(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * The status message for `name` as currently known to this session, or
 * undefined when none is set (or the character isn't visible anywhere).
 */
export function findStatusMessage(
  session: IdentitySession | undefined,
  name: string,
): string | undefined {
  if (!session) {
    return undefined;
  }

  // Own character: the session's own STA is authoritative.
  if (sameName(session.character, name)) {
    return session.ownStatusmsg || undefined;
  }

  // Any channel roster the character is visible in.
  for (const channel of Object.values(session.channels)) {
    const member = channel.members.find((m) => sameName(m.character, name));
    if (member?.statusmsg) {
      return member.statusmsg;
    }
  }

  // An open DM with this partner.
  for (const dm of Object.values(session.dms)) {
    if (sameName(dm.partner, name) && dm.statusmsg) {
      return dm.statusmsg;
    }
  }

  // Friends / bookmarks (presence-enriched by the server).
  for (const row of [
    ...(session.social?.friends ?? []),
    ...(session.social?.bookmarks ?? []),
  ]) {
    if (sameName(row.name, name) && row.statusmsg) {
      return row.statusmsg;
    }
  }

  return undefined;
}
