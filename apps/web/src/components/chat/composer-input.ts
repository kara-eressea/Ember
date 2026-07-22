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
