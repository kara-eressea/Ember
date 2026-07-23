// Type-anywhere focus capture (#395): when nothing editable is focused and no
// dialog/palette/prefs window is capturing keys, a printable keystroke on the
// window should focus the composer and deliver that character — the same
// "start typing anywhere" affordance Discord and the official client offer.
// Built to sit alongside the click-to-focus surface (#317).
//
// This module is the pure decision: given the keydown and the current focus /
// overlay state, does the keystroke belong to the composer? Keeping it out of
// the component makes the guard directly unit-testable and keeps every exclusion
// in one place.

/** The subset of KeyboardEvent the guard reads — native or synthetic. */
export interface TypeAnywhereKey {
  readonly key: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly altKey: boolean;
  readonly defaultPrevented: boolean;
  /** True mid-IME-composition; those keystrokes belong to the IME, not us. */
  readonly isComposing?: boolean;
}

export interface TypeAnywhereContext {
  /** document.activeElement at event time (null when nothing is focused). */
  readonly activeElement: Element | null;
  /** Whether a dialog/palette/prefs window is currently open (aria-modal). */
  readonly modalOpen: boolean;
}

function isEditable(el: Element | null): boolean {
  if (el === null) {
    return false;
  }
  const tag = el.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") {
    return true;
  }
  // CodeMirror's editable surface is an inner contenteditable, so this also
  // covers the composer already being focused (the inline editor).
  return (el as HTMLElement).isContentEditable === true;
}

/**
 * Should this keydown be redirected into the composer? True only for a bare
 * printable character typed while nothing editable is focused and no modal is
 * open. Everything else — modifier combos (Ctrl/Meta/Alt), navigation and
 * control keys (Enter, Escape, Arrows, Tab, F-keys…), keystrokes already
 * claimed by another handler, IME composition, and anything typed while an
 * input/textarea/contenteditable already has focus — is left alone, so the
 * message-log's Esc / Ctrl+K handlers and every other input keep their keys.
 */
export function shouldRedirectToComposer(
  event: TypeAnywhereKey,
  ctx: TypeAnywhereContext,
): boolean {
  if (ctx.modalOpen) {
    return false;
  }
  if (event.defaultPrevented || event.isComposing === true) {
    return false;
  }
  if (event.ctrlKey || event.metaKey || event.altKey) {
    return false;
  }
  // Printable characters surface as a single-code-point key ("a", "7", " ",
  // "é"); named keys ("Enter", "ArrowUp", "Tab", "Escape") are longer.
  if (event.key.length !== 1) {
    return false;
  }
  return !isEditable(ctx.activeElement);
}
