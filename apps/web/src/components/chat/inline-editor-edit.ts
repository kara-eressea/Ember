// Headless edit helpers for the inline CodeMirror composer (InlineEditor.tsx).
// Kept out of the .tsx so the transaction/annotation logic is unit-testable
// without a DOM (the editor itself needs a real view; these do not).

import {
  Annotation,
  type Transaction,
  type TransactionSpec,
} from "@codemirror/state";

/** Marks a dispatch as programmatic — the controlled-value reconciliation and
 * every toolbar/eicon applyEdit — rather than a user keystroke. The change
 * listener stays silent for these so the inline path matches the textarea:
 * React-driven setText never fires the textarea's onChange, so it never emits
 * a typing TPN or resets the slash-autocomplete state. Without this, toolbar
 * and eicon inserts (and draft/recall syncs) sent a spurious TPN on the wire
 * and collapsed the slash popover (#269 item 1). */
export const externalEdit = Annotation.define<boolean>();

/** True when an update carries a programmatic edit (so onChange must not fire).
 * User keystrokes produce transactions without the annotation. */
export function isProgrammatic(transactions: readonly Transaction[]): boolean {
  return transactions.some((tr) => tr.annotation(externalEdit) === true);
}

/** Full-document replace that carries the caret to the end of the new text.
 * A bare {from,to,insert} maps the selection through the change and collapses
 * it to position 0, so a pref flip or draft recall dropped the caret to the
 * start of the restored text (#269 item 2). Mirrors the selection-carrying
 * applyEdit path (#260). */
export function fullDocReplace(
  docLength: number,
  text: string,
): TransactionSpec {
  return {
    changes: { from: 0, to: docLength, insert: text },
    selection: { anchor: text.length },
    annotations: externalEdit.of(true),
  };
}
