// The textarea-shaped surface both composer inputs expose (#226). Every
// composer-edit.ts transform and the toolbar's caret reflection program
// against this handle, so the classic <textarea> and the inline-rendering
// CodeMirror editor are interchangeable behind it. Kept separate from
// InlineEditor.tsx so the CodeMirror chunk stays dynamic-import-only.

import type { KeyboardEvent as ReactKeyboardEvent } from "react";

/** The textarea-compatible surface the composer + toolbar program against. */
export interface ComposerInputHandle {
  readonly value: string;
  readonly selectionStart: number;
  readonly selectionEnd: number;
  focus(): void;
  setSelectionRange(start: number, end: number): void;
  /** Replaces `document.activeElement === el` checks — CodeMirror's focus
   * target is an inner contenteditable, not the component root. */
  focused(): boolean;
  /** Atomically replace the whole text and the selection in one edit,
   * keeping focus. The CodeMirror handle implements this as a single
   * synchronous transaction — the composer's programmatic edits (toolbar
   * wraps, eicon inserts, slash completion) must never defer the selection
   * restore, or fast subsequent input races it (a rAF-deferred
   * setSelectionRange can collapse a select-all the user just made). The
   * textarea handle deliberately does not implement it: that path keeps the
   * legacy setState + rAF restore behavior unchanged. */
  applyEdit?(text: string, selStart: number, selEnd: number): void;
  /** Focus the input, placing the caret near a viewport point when the
   * surface can (CodeMirror's posAtCoords, falling back to the doc end).
   * Powers the click-to-focus input bar (#313): a click on the bar's inert
   * chrome focuses the composer with a sensible caret. The textarea handle
   * omits it — the browser keeps its own caret on focus(). */
  focusAtCoords?(clientX: number, clientY: number): void;
}

/** Adapter: the legacy textarea satisfies the same handle. */
export function textareaHandle(
  el: HTMLTextAreaElement | null,
): ComposerInputHandle | null {
  if (!el) {
    return null;
  }
  return {
    get value() {
      return el.value;
    },
    get selectionStart() {
      return el.selectionStart;
    },
    get selectionEnd() {
      return el.selectionEnd;
    },
    focus: () => {
      el.focus();
    },
    setSelectionRange: (s, e) => {
      el.setSelectionRange(s, e);
    },
    focused: () => document.activeElement === el,
  };
}

/** React-keyboard-event shim so one Composer.onKeyDown serves both paths —
 * the handler only touches key/shiftKey/ctrlKey/metaKey/preventDefault,
 * which native and synthetic events share. */
export type AnyKeyEvent =
  KeyboardEvent | ReactKeyboardEvent<HTMLTextAreaElement>;
