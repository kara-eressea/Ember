// Eligible "Invite to →" targets (#316). CIU is chanop-restricted and only
// applies to private/invite-only rooms (client-commands.md): official public
// channels use their plain name as the key and refuse CIU, while private/open
// rooms carry opaque ADH- ids. We therefore offer a channel only when it is a
// private room the viewer is live in AND their own character holds owner/op in
// that room's oplist — mirroring the wire rule so the menu never lists a
// command the server would reject.

import type { ChannelView } from "../../stores/sessions.js";
import { roleFor } from "./member-roles.js";

export interface InviteTarget {
  /** Wire key (ADH- id) — sent as CIU's `channel`, never shown. */
  key: string;
  /** Human title (#311) — the only thing the menu displays. */
  title: string;
}

/** Private/open rooms use opaque ADH- ids as their key; official public
 * channels use their plain name. Case-insensitive: keys arrive as "ADH-…". */
export function isPrivateRoom(key: string): boolean {
  return key.toLowerCase().startsWith("adh-");
}

/** Private rooms the viewer's character can invite to, title-sorted for a
 * stable menu. Empty when there is nothing eligible — callers hide the
 * submenu entirely rather than show a dead affordance. */
export function inviteTargets(
  channels: Record<string, ChannelView>,
  ownCharacter: string,
): InviteTarget[] {
  return Object.values(channels)
    .filter((ch) => ch.joined && isPrivateRoom(ch.key))
    .filter((ch) => roleFor(ownCharacter, ch.oplist) !== null)
    .map((ch) => ({ key: ch.key, title: ch.title }))
    .sort((a, b) => a.title.localeCompare(b.title));
}
