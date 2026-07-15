// Pure data helpers behind the ChannelBrowser dialog (COMPONENTS.md §11) —
// filtering, join-state derivation, and the staleness label, kept out of the
// component so they unit-test without DOM.

import type { DirectoryChannelDto } from "../../lib/api.js";

/** Case-insensitive filter over name and topic (the display title — rows
 * carry no description, so the title is all the "topic" there is). */
export function filterDirectory(
  channels: DirectoryChannelDto[],
  query: string,
): DirectoryChannelDto[] {
  const needle = query.trim().toLowerCase();
  if (!needle) {
    return channels;
  }
  return channels.filter(
    (channel) =>
      channel.key.toLowerCase().includes(needle) ||
      channel.title.toLowerCase().includes(needle),
  );
}

export type JoinState = "join" | "joined" | "pinned";

/** Button state for a directory row: ⚲ Pinned outranks ✓ Joined; anything
 * not currently joined offers Join (a pinned-but-left channel included —
 * the pin is a sidebar concern, the button answers "can I get in"). */
export function joinStateFor(
  key: string,
  channels: Record<string, { joined: boolean; pinned: boolean }>,
): JoinState {
  const channel = channels[key];
  if (!channel?.joined) {
    return "join";
  }
  return channel.pinned ? "pinned" : "joined";
}

/** Honest staleness for the header sub — ORS counts are point-in-time. */
export function stalenessLabel(
  refreshedAt: string | null,
  now: number,
): string {
  if (refreshedAt === null) {
    return "never refreshed";
  }
  const ageMs = now - new Date(refreshedAt).getTime();
  if (ageMs < 60_000) {
    return "updated just now";
  }
  const minutes = Math.floor(ageMs / 60_000);
  if (minutes < 60) {
    return `updated ${String(minutes)}m ago`;
  }
  const hours = Math.floor(minutes / 60);
  return `updated ${String(hours)}h ago`;
}
