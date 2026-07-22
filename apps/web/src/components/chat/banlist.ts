// Parsing the channel banlist out of the SYS line it arrives on. CBL has no
// structured response on the wire — the server answers a banlist request with
// a channel SYS whose text either names the banned characters or says there
// are none (see fchat-sim #handleBanlist, and F-List's live wording). The
// room-settings "Banned characters" pane reuses this same plumbing: it fires
// channel.banlist and reads the freshest matching SYS line back out of the
// message buffer.

const NAME_SEP = /\s*,\s*/;

// "Channel bans for <title>: A, B, C." — capture the comma-list after the
// colon. Kept deliberately loose on the prefix so a wording tweak on either
// the sim or the live server still parses.
const LIST_RE = /bans?\b[^:]*:\s*(.+?)\s*\.?\s*$/i;

// "There are no bans set on <title>." / "…has no bans." — an explicit empty
// list, distinct from "this line isn't a banlist at all" (null).
const EMPTY_RE = /\bno bans?\b/i;

/**
 * Parse a channel SYS line into the banned-character list.
 * Returns the names (possibly empty for an explicit "no bans" answer), or
 * `null` when the line is not a banlist response at all.
 */
export function parseBanlistLine(text: string): string[] | null {
  const trimmed = text.trim();
  if (EMPTY_RE.test(trimmed)) {
    return [];
  }
  const match = LIST_RE.exec(trimmed);
  if (!match?.[1]) {
    return null;
  }
  const names = match[1]
    .split(NAME_SEP)
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
  return names.length > 0 ? names : null;
}
