// Pure logic behind the Ad Center (M10 step 5) — kept out of the component
// so the counter thresholds, tag rules and lossiness copy are unit-testable
// without a DOM.

import type { MdLossDiagnostic, MdLossKind } from "@emberchat/markdown-bbcode";
import { MAX_AD_TAGS, MAX_AD_TAG_LENGTH } from "@emberchat/protocol";

/** Counter severity against the live lfrp_max (COMPONENTS §2c: amber ≥ 90%,
 * red ≥ 98%, at-limit when the cap is reached). */
export type CounterLevel = "normal" | "amber" | "red" | "cap";

export function counterLevel(bytes: number, max: number): CounterLevel {
  if (max <= 0 || bytes >= max) {
    return "cap";
  }
  const frac = bytes / max;
  if (frac >= 0.98) {
    return "red";
  }
  if (frac >= 0.9) {
    return "amber";
  }
  return "normal";
}

/** 1-based line number of a character offset — the lossiness strip shows
 * `@L{n}` refs while diagnostics carry absolute offsets. */
export function lineOfOffset(source: string, offset: number): number {
  let line = 1;
  const end = Math.min(offset, source.length);
  for (let i = 0; i < end; i += 1) {
    if (source[i] === "\n") {
      line += 1;
    }
  }
  return line;
}

/** Plain-language copy per diagnostic kind — no protocol jargon in
 * user-facing text (the wire details live in specs and code, not the UI). */
export const LOSSINESS_COPY: Record<
  MdLossKind,
  { label: string; copy: string }
> = {
  "unsupported-block": {
    label: "Headings, lists and quotes post as plain text",
    copy: "Chat messages don't support that formatting — the line reaches the channel exactly as typed.",
  },
  "underscore-emphasis": {
    label: "Underscore emphasis won't italicize",
    copy: "Chat formatting uses *asterisks*. The underscores post as typed.",
  },
  "unsupported-bbcode": {
    label: "That [tag] doesn't work in chat",
    copy: "It has no chat equivalent, so it posts as text — brackets and all.",
  },
  "invalid-bbcode-param": {
    label: "A tag is missing or has a bad value",
    copy: "Tags like [color=red] post as plain text when the value is wrong or absent.",
  },
  "unterminated-bbcode": {
    label: "An unclosed [tag]",
    copy: "It never closes, so it posts as text instead of formatting.",
  },
  "unterminated-emphasis": {
    label: "Unclosed emphasis marks",
    copy: "The ** or ~~ is never closed, so the marks post as typed.",
  },
};

/** How many diagnostic rows the strip shows before "+N more" (design:
 * 1–4 concurrent warnings, then overflow). */
export const LOSSINESS_VISIBLE = 4;

export interface StripModel {
  visible: MdLossDiagnostic[];
  overflow: number;
}

export function stripModel(diags: MdLossDiagnostic[]): StripModel {
  return {
    visible: diags.slice(0, LOSSINESS_VISIBLE),
    overflow: Math.max(0, diags.length - LOSSINESS_VISIBLE),
  };
}

/** Commits a typed tag into the chip list: trimmed, capped at 30 chars /
 * 10 tags, exact duplicates dropped (the server normalizes the same way).
 * Returns the unchanged array when nothing commits. */
export function commitTag(tags: string[], raw: string): string[] {
  const tag = raw.trim();
  if (
    tag.length === 0 ||
    tag.length > MAX_AD_TAG_LENGTH ||
    tags.length >= MAX_AD_TAGS ||
    tags.includes(tag)
  ) {
    return tags;
  }
  return [...tags, tag];
}

/** First line of an ad's Markdown — the library row title. */
export function adTitle(content: string): string {
  const line = content.split("\n", 1)[0]?.trim() ?? "";
  return line.length > 0 ? line : "(empty ad)";
}

/** Moves index `from` to position `to` in a copy of the list. */
/** Where a selected row index lands after `reorder(list, from, to)`. */
export function movedSelection(s: number, from: number, to: number): number {
  if (s === from) {
    return to;
  }
  if (from < s && to >= s) {
    return s - 1;
  }
  if (from > s && to <= s) {
    return s + 1;
  }
  return s;
}

export function reorder<T>(list: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || from >= list.length) {
    return list;
  }
  const next = [...list];
  const [moved] = next.splice(from, 1);
  next.splice(Math.max(0, Math.min(to, next.length)), 0, moved!);
  return next;
}
