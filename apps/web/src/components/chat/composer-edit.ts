// The pure half of the composer's text editing (#226 pre-rework safety net).
// The composer is a plain <textarea>: inserting an eicon, wrapping a
// selection in a marker pair, stripping colour tags and picking the send to
// recall are all string/selection transforms with no DOM dependency. Keeping
// them here lets the contenteditable rework re-target the same tested
// contract instead of re-deriving the caret maths by hand.

/** A text value plus the selection to restore after applying an edit. */
export interface TextEdit {
  /** The new textarea value. */
  text: string;
  /** Selection start to restore (caret when equal to selEnd). */
  selStart: number;
  /** Selection end to restore. */
  selEnd: number;
}

/**
 * Insert `snippet` over the [from, to) selection, leaving the caret directly
 * after the inserted run (matches the eicon-picker / "+" insertion path).
 */
export function insertAt(
  text: string,
  from: number,
  to: number,
  snippet: string,
): TextEdit {
  const next = text.slice(0, from) + snippet + text.slice(to);
  const caret = from + snippet.length;
  return { text: next, selStart: caret, selEnd: caret };
}

/**
 * Wrap the [from, to) selection in an open/close marker pair, restoring the
 * selection around the original inner run (so the user keeps typing inside
 * the wrap). An empty selection produces an empty wrap with the caret between
 * the markers.
 */
export function wrapRange(
  text: string,
  from: number,
  to: number,
  open: string,
  close: string,
): TextEdit {
  const selected = text.slice(from, to);
  const next = text.slice(0, from) + open + selected + close + text.slice(to);
  return {
    text: next,
    selStart: from + open.length,
    selEnd: to + open.length,
  };
}

/** Matches a single [color=name] or [/color] tag (case-insensitive). */
const COLOR_TAG = /\[color=[a-z]+\]|\[\/color\]/gi;

/**
 * Strip any [color] open/close tags from the [from, to) selection, leaving
 * the covered contents untouched. The selection is restored around the
 * (now shorter) stripped run — the inverse of the swatch wrap.
 */
export function stripColor(text: string, from: number, to: number): TextEdit {
  const stripped = text.slice(from, to).replace(COLOR_TAG, "");
  const next = text.slice(0, from) + stripped + text.slice(to);
  return { text: next, selStart: from, selEnd: from + stripped.length };
}

/** The minimal shape of an outbox row the recall logic needs. */
export interface PendingLike {
  id: string;
  /** ISO-8601 creation timestamp — recall targets the newest by creation. */
  createdAt: string;
}

/**
 * The send ArrowUp recalls: the newest pending row *by creation time*, not by
 * release time — a shorter delay armed later must not shadow an earlier
 * message (audit). Returns undefined when nothing is pending.
 */
export function newestPending<T extends PendingLike>(
  pending: readonly T[],
): T | undefined {
  if (pending.length === 0) {
    return undefined;
  }
  return [...pending]
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .at(-1);
}

/**
 * The slash-autocomplete keyboard decision for the highlighted row when the
 * command word is still being chosen (list mode). Tab always completes;
 * Enter completes too — unless what's typed already *is* the highlighted
 * command exactly, in which case Enter runs it (so a bare "/help" or
 * "/bottle" fires on the first Enter instead of only re-completing itself).
 */
export function slashKeyAction(
  key: string,
  liveText: string,
  highlightedName: string | undefined,
): "complete" | "run" | "none" {
  if (highlightedName === undefined) {
    return "none";
  }
  const alreadyTyped = liveText.slice(1).toLowerCase() === highlightedName;
  if (key === "Tab") {
    return "complete";
  }
  if (key === "Enter") {
    return alreadyTyped ? "run" : "complete";
  }
  return "none";
}

/**
 * List mode = the popover is open and no separator yet follows the command
 * word ("/ba" is list mode, "/ban Kestrel" is signature-hint mode). Arrow/
 * Tab/Enter selection only applies in list mode; in hint mode Enter sends.
 */
export function isSlashListMode(liveText: string): boolean {
  return !/^\/\S*\s/.test(liveText);
}
