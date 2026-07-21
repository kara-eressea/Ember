// The pure half of the composer formatting toolbar (#205, toolbar spec).
// Clusters, the narrow-width priority collapse, caret format reflection and
// the timer label are all plain functions here so they unit-test without a
// DOM; ComposerToolbar.tsx is the thin React shell over them.

export type ToolbarActionId =
  | "bold"
  | "italic"
  | "underline"
  | "strike"
  | "sup"
  | "sub"
  | "spoiler"
  | "code"
  | "noparse"
  | "color"
  | "eicon"
  | "charicon"
  | "link"
  | "charlink"
  | "timer";

/** Left→right toolbar order: six clusters separated by dividers (spec §2). */
export const TOOLBAR_CLUSTERS: readonly (readonly ToolbarActionId[])[] = [
  ["bold", "italic", "underline", "strike"],
  ["sup", "sub"],
  ["spoiler", "code", "noparse"],
  ["color", "eicon", "charicon"],
  ["link", "charlink"],
  ["timer"],
];

/** Plain-language labels — never BBCode jargon (spec: "Colour" not
 * [color], "Character profile link" not [user]). */
export const ACTION_LABELS: Record<ToolbarActionId, string> = {
  bold: "Bold",
  italic: "Italic",
  underline: "Underline",
  strike: "Strikethrough",
  sup: "Superscript",
  sub: "Subscript",
  spoiler: "Spoiler",
  code: "Code",
  noparse: "Show text exactly, no formatting",
  color: "Colour",
  eicon: "Eicon",
  charicon: "Character icon",
  link: "Add link",
  charlink: "Character profile link",
  timer: "Send timer",
};

/** Collapse steps, first-to-collapse first (spec §8): Bold, Italic, Eicon
 * and Timer survive to the narrowest width; sub/sup fold first. */
export const COLLAPSE_STEPS: readonly (readonly ToolbarActionId[])[] = [
  ["sub", "sup"],
  ["underline", "strike"],
  ["spoiler", "code", "noparse"],
  ["link", "charlink"],
  ["charicon"],
  ["color"],
];

/** The four that survive every collapse step. */
export const ALWAYS_KEPT: readonly ToolbarActionId[] = [
  "bold",
  "italic",
  "eicon",
  "timer",
];

// Width model (spec §9): 30px IconBtn + 2px gap, 1px divider with 6px
// margins, 0 8px row padding, and the pinned right slot (help or ⋯ — same
// 30px either way) behind an auto spacer.
const BTN = 32; // 30 + gap
const DIVIDER = 13; // 1 + 2×6
const PADDING = 16;
const RIGHT_SLOT = 38; // 30px button + minimum spacer breathing room

function requiredWidth(
  collapsed: ReadonlySet<ToolbarActionId>,
  timerExtraPx: number,
): number {
  let width = PADDING + RIGHT_SLOT;
  let nonEmptyClusters = 0;
  for (const cluster of TOOLBAR_CLUSTERS) {
    const visible = cluster.filter((id) => !collapsed.has(id));
    if (visible.length === 0) {
      continue; // a fully-collapsed cluster drops its divider too (spec §6)
    }
    nonEmptyClusters += 1;
    width += visible.length * BTN;
    if (visible.includes("timer")) {
      width += timerExtraPx;
    }
  }
  width += Math.max(0, nonEmptyClusters - 1) * DIVIDER;
  return width;
}

/**
 * Which actions fold into the `⋯` overflow at the given row width. Never
 * wraps, never scrolls: steps collapse in priority order until the row
 * fits; Bold/Italic/Eicon/Timer always survive. `timerExtraPx` is the
 * armed timer's widened mono label.
 */
export function collapsedActions(
  width: number,
  timerExtraPx = 0,
): ToolbarActionId[] {
  const collapsed = new Set<ToolbarActionId>();
  for (const step of COLLAPSE_STEPS) {
    if (requiredWidth(collapsed, timerExtraPx) <= width) {
      break;
    }
    for (const id of step) {
      collapsed.add(id);
    }
  }
  // Overflow-menu order = toolbar order, not collapse order.
  return TOOLBAR_CLUSTERS.flat().filter((id) => collapsed.has(id));
}

/** Marker pairs the caret scan counts (odd count before caret = inside). */
const PAIR_MARKERS: readonly [ToolbarActionId, string][] = [
  ["bold", "**"],
  ["strike", "~~"],
  ["spoiler", "||"],
  ["code", "`"],
];

/** BBCode wrappers reflected from tag depth (usable in both modes). */
const TAG_FORMATS: readonly [ToolbarActionId, string][] = [
  ["bold", "b"],
  ["italic", "i"],
  ["underline", "u"],
  ["strike", "s"],
  ["sup", "sup"],
  ["sub", "sub"],
  ["noparse", "noparse"],
];

function countOccurrences(text: string, marker: string): number {
  let count = 0;
  let at = 0;
  while ((at = text.indexOf(marker, at)) !== -1) {
    count += 1;
    at += marker.length;
  }
  return count;
}

/**
 * Which formats are active at the caret — the toggle-reflection pass
 * (spec §3, Q7). A lightweight scan of the text before the caret: an odd
 * number of a Markdown marker, or a positive BBCode open/close depth,
 * means the caret sits inside that format. Approximate by design (the
 * composer is a plain textarea, not a structured editor), but exact for
 * well-formed input.
 */
export function caretFormats(
  text: string,
  caret: number,
): Set<ToolbarActionId> {
  const before = text.slice(0, caret);
  const active = new Set<ToolbarActionId>();
  // Doubled markers first, then the leftover single `*` for italic.
  for (const [id, marker] of PAIR_MARKERS) {
    if (countOccurrences(before, marker) % 2 === 1) {
      active.add(id);
    }
  }
  const singleStars =
    countOccurrences(before, "*") - 2 * countOccurrences(before, "**");
  if (singleStars % 2 === 1) {
    active.add("italic");
  }
  const lower = before.toLowerCase();
  for (const [id, tag] of TAG_FORMATS) {
    const depth =
      countOccurrences(lower, `[${tag}]`) -
      countOccurrences(lower, `[/${tag}]`);
    if (depth > 0) {
      active.add(id);
    }
  }
  return active;
}

/** Compact mono label for the armed timer chip: 15s · 30s · 1m · 5m. */
export function delayLabel(seconds: number): string {
  if (seconds <= 0) {
    return "";
  }
  if (seconds < 60) {
    return `${String(seconds)}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest === 0
    ? `${String(minutes)}m`
    : `${String(minutes)}m${String(rest)}s`;
}

/** m:ss for the queued-send countdown chip. */
export function countdownLabel(secondsLeft: number): string {
  const clamped = Math.max(0, secondsLeft);
  const minutes = Math.floor(clamped / 60);
  const rest = clamped % 60;
  return `${String(minutes)}:${String(rest).padStart(2, "0")}`;
}

/** The delay presets in the Timer popover (spec §5); the protocol caps
 * sendDelaySeconds at 300, so Custom clamps into 1…300. */
export const TIMER_PRESETS = [
  { seconds: 0, label: "Off (send instantly)" },
  { seconds: 15, label: "15 seconds" },
  { seconds: 30, label: "30 seconds" },
  { seconds: 60, label: "1 minute" },
  { seconds: 300, label: "5 minutes" },
] as const;

export const MAX_DELAY_SECONDS = 300;

export function clampDelay(seconds: number): number {
  if (!Number.isFinite(seconds)) {
    return 0;
  }
  return Math.min(MAX_DELAY_SECONDS, Math.max(0, Math.round(seconds)));
}
