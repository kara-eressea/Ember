// The pure half of the conversation toolbar's priority collapse (#375, MP1
// spec §3) — the composer toolbar's mechanism (composer-toolbar.ts) applied to
// ChannelHeader / DmHeader. Same shape on purpose: a priority-ordered table of
// collapse steps and a written-down width model, so the decision unit-tests
// without a DOM and ChannelHeader.tsx stays a shell over it.
//
// It is a port rather than a shared module because the two rows are only alike
// down to the mechanism. The composer's row is six fixed clusters with
// dividers between them and one action (the armed timer) that changes width;
// this row's control set is per conversation — a channel and a DM offer
// different chips, the room chip is op-only, the clock only exists for a
// partner whose timezone is known. One config covering both would be a wider
// abstraction than either needs. The measurement itself *is* shared
// (lib/useRowWidth.ts), and so is the popover the ⋯ menu hangs in.
//
// This replaces the provisional HEADER_DENSE_MAX_WIDTH threshold (the old
// `@media (max-width: 820px)` rule): the topic slot and the DM clock are no
// longer a window-width decision but the first two entries in the collapse
// order, which is what they always were in spirit. Measuring is strictly
// better here because the row is not the window — the rail hides (#346) and
// the sidebar drags between 180 and 400 (#292), so the same 820px window
// hands this header anywhere from ~330 to ~610 pixels of row.

/** Everything in the row that can fold into the `⋯` overflow. The inbox and
 * the search field are deliberately absent: they are the two survivors. */
export type HeaderControlId =
  | "topic"
  | "clock"
  | "pin"
  | "mute"
  | "ignore"
  | "room"
  | "members"
  | "panel"
  | "actions"
  | "close";

/** Left→right order in the row. The ⋯ menu lists in the same order, so a
 * control reads in the same place whichever side of the fold it is on. */
export const HEADER_CONTROL_ORDER: readonly HeaderControlId[] = [
  "topic",
  "clock",
  "pin",
  "mute",
  "ignore",
  "room",
  "members",
  "panel",
  "actions",
  "close",
];

/**
 * Collapse steps, first-to-collapse first. The order is by how much a control
 * is worth at a glance while reading a conversation:
 *
 * 1. The topic slot and the partner's clock — the only two entries that are
 *    read-outs rather than actions, both truncated to near-uselessness by the
 *    time the row is tight, and both still available in full (the topic from
 *    the ⋯ menu and the room-settings window, the clock from the profile
 *    panel). This is exactly what the 820px rule used to do, and for the same
 *    reason: the clock was eating the DM partner's name.
 * 2. Pin and mute — set once and forgotten, and both also live in the
 *    conversation's sidebar row menu.
 * 3. Ignore, room settings and close — infrequent, deliberate actions. Each
 *    opens something (a window, a confirmation, a route change), so a menu is
 *    a perfectly good doorway; none of them is a glanceable state.
 * 4. The partner actions menu — a menu already, but the one thing on the row
 *    that reaches the whole per-character toolkit, so it outranks the three
 *    above.
 * 5. The member-list and profile-panel toggles — last, because they steer what
 *    the rest of the screen shows and are used mid-read rather than mid-task.
 *
 * Search and the inbox are not here at all: search is the row's one text
 * field and stays right-most (the v0.20.0 full-width toolbar decision), the
 * inbox is per identity and is the only unread signal on screen while a
 * conversation is open.
 */
export const HEADER_COLLAPSE_STEPS: readonly (readonly HeaderControlId[])[] = [
  ["topic", "clock"],
  ["pin", "mute"],
  ["ignore", "room", "close"],
  ["actions"],
  ["members", "panel"],
];

/** The controls that sit after the row's divider; it goes when they all do. */
const AFTER_DIVIDER: readonly HeaderControlId[] = [
  "members",
  "panel",
  "actions",
  "close",
];

/** The controls that share .headerCluster, whose own gap is 2px not 4px. */
const CLUSTERED: readonly HeaderControlId[] = ["pin", "mute", "ignore", "room"];

/* Width model. The row's chrome is fixed, so what each part costs can be
 * written down once and summed — the same trick composer-toolbar.ts plays.
 * Every number below is a width measured off the rendered row in Chromium at
 * 100% scale, plus the gap that follows it: a 30px .iconBtn in the header's
 * 4px gap is 34, the same chip inside .headerCluster is 32, the 1px
 * .tbDivider carries 6px margins. `.header`'s own 18/10 padding is *not* in
 * here — the width these are compared against is a ResizeObserver
 * contentRect, which is the content box and has already taken it off. (No
 * zoom correction either: the interface-scale pref zooms the row and its
 * contents alike, so both sides of the comparison stay in the same units —
 * unlike the window-width tiers, which is exactly why those live in
 * layout-mode.ts.) */
/** The `#` glyph or presence dot, plus .headerIdentity's 8px gap. */
const GLYPH = 18;
const CHIP = 34;
const CLUSTER_CHIP = 32;
/** …and the one 4px gap the cluster itself sits in. */
const CLUSTER_GAP = 4;
/** The member toggle carries its count beside the glyph. */
const MEMBERS = 52;
const DIVIDER = 17;
/** The clock's mono read-out and its glyph — 71px of "10:12 PM" plus the
 * identity block's 8px gap. A 24-hour locale is narrower; budgeting for the
 * wider one collapses a shade early rather than a shade late. */
const CLOCK = 79;
/** The narrowest topic worth reading: the hairline and its two 8px gaps, then
 * ~8 characters. Below this the slot is an ellipsis with almost nothing in
 * front of it — which is the judgement the old 820px rule was making. */
const TOPIC = 78;
const INBOX = 34;
/** The search pill parked as a magnifier. It only widens on the `wide` tier,
 * where nothing collapses at all, and on focus — where the CSS drops the
 * topic slot for exactly as long as the field is focused. */
const SEARCH = 36;
/** The ⋯ button, budgeted only once something has folded into it. */
const OVERFLOW = 34;
/** The conversation name while it shares the identity block with a topic. */
const NAME_WITH_TOPIC = 84;
/** …and once the topic has gone, where the name is the block's whole point
 * and a truncated one is the row's worst failure: ~15 characters. Reclaiming
 * this is why dropping the topic buys less room than the topic occupied — the
 * row does not immediately hand the reclaimed pixels back to a chip. */
const NAME_ALONE = 120;

function costOf(id: HeaderControlId): number {
  switch (id) {
    case "topic":
      return TOPIC;
    case "clock":
      return CLOCK;
    case "pin":
    case "mute":
    case "ignore":
    case "room":
      return CLUSTER_CHIP;
    case "members":
      return MEMBERS;
    case "panel":
    case "actions":
    case "close":
      return CHIP;
  }
}

function requiredWidth(
  present: readonly HeaderControlId[],
  collapsed: ReadonlySet<HeaderControlId>,
): number {
  const inline = present.filter((id) => !collapsed.has(id));
  let width = GLYPH + INBOX + SEARCH;
  width += inline.includes("topic") ? NAME_WITH_TOPIC + TOPIC : NAME_ALONE;
  for (const id of inline) {
    if (id !== "topic") {
      width += costOf(id);
    }
  }
  if (inline.some((id) => CLUSTERED.includes(id))) {
    width += CLUSTER_GAP;
  }
  if (inline.some((id) => AFTER_DIVIDER.includes(id))) {
    width += DIVIDER;
  }
  if (collapsed.size > 0) {
    width += OVERFLOW;
  }
  return width;
}

/**
 * Which of `present` fold into the `⋯` overflow at the given row width, in
 * row order. Steps collapse in priority order until the row fits; the inbox
 * and search never take part, so at any width they are what is left.
 */
export function collapsedHeaderControls(
  width: number,
  present: readonly HeaderControlId[],
): HeaderControlId[] {
  const collapsed = new Set<HeaderControlId>();
  for (const step of HEADER_COLLAPSE_STEPS) {
    if (requiredWidth(present, collapsed) <= width) {
      break;
    }
    for (const id of step) {
      if (present.includes(id)) {
        collapsed.add(id);
      }
    }
  }
  return HEADER_CONTROL_ORDER.filter((id) => collapsed.has(id));
}
