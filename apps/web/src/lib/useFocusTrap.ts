import { useEffect, type RefObject } from "react";

// Shared modal focus management (WP-7). A dialog that only focuses itself on
// open still lets Tab walk out into the app behind it — and closing it drops
// focus on the body, which strands keyboard and screen-reader users far from
// the control they opened it with. This hook gives every `aria-modal` surface
// the three things that convention requires:
//
//   - initial focus (the dialog box, or a named element inside it),
//   - Tab / Shift+Tab wrap-around within the dialog's focusables, and
//   - focus restored, on unmount, to whatever had it when the dialog opened.
//
// The Tab listener lives on the dialog element rather than the window, so
// stacked dialogs (Post ads over the Ad Center) each trap their own subtree
// without a second global priority stack: the topmost one holds focus, and
// only its listener sees the key.

/** Elements the browser will land on with Tab, in document order. */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function focusablesIn(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (element) =>
      element.tabIndex >= 0 &&
      !element.hasAttribute("hidden") &&
      element.getAttribute("aria-hidden") !== "true",
  );
}

/**
 * Trap Tab inside `ref`'s subtree while it is mounted, focusing `initial`
 * (default: the container itself, which dialogs give `tabIndex={-1}`) on open
 * and restoring focus to the opener on close.
 */
export function useFocusTrap(
  ref: RefObject<HTMLElement | null>,
  initial?: RefObject<HTMLElement | null>,
) {
  useEffect(() => {
    const root = ref.current;
    if (!root) {
      return;
    }
    const opener =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : undefined;
    (initial?.current ?? root).focus();

    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Tab" || !root) {
        return;
      }
      const items = focusablesIn(root);
      const first = items[0];
      const last = items.at(-1);
      if (!first || !last) {
        // Nothing to move to — keep the key inside the dialog anyway.
        event.preventDefault();
        root.focus();
        return;
      }
      const active = document.activeElement;
      if (!event.shiftKey && (active === last || !root.contains(active))) {
        event.preventDefault();
        first.focus();
      } else if (
        event.shiftKey &&
        (active === first || active === root || !root.contains(active))
      ) {
        event.preventDefault();
        last.focus();
      }
    }

    root.addEventListener("keydown", onKeyDown);
    return () => {
      root.removeEventListener("keydown", onKeyDown);
      // The opener can be gone (a row that the dialog itself deleted); only
      // return the focus if it is still there to take it.
      if (opener?.isConnected) {
        opener.focus();
      }
    };
    // Mount/unmount only: the refs are stable and re-running would re-focus
    // the dialog out from under whatever the user is typing in.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
