// Window focus as reactive state (#440). "Is the user looking at the app?" is
// the gate on marking the open conversation read: an unfocused window accrues
// unread like any background conversation, and regaining focus at the tail is
// what marks it read (the Discord model).
//
// Focus, not visibility: a window that is fully on screen behind another app
// is not attention. That is the same signal desktop-notify and highlight-notify
// already self-gate on (document.hasFocus()), so all three agree by
// construction.

import { useUiStore } from "../stores/ui.js";

/** Installs the focus/blur listeners and seeds the current state; returns the
 * teardown. The seed matters on its own: a tab restored or opened in the
 * background never fires a blur, so the optimistic store default would stay
 * wrong until the user first left the window. */
export function startWindowFocusTracking(): () => void {
  const apply = (focused: boolean) => {
    useUiStore.getState().setWindowFocused(focused);
  };
  const onFocus = () => {
    apply(true);
  };
  const onBlur = () => {
    apply(false);
  };
  window.addEventListener("focus", onFocus);
  window.addEventListener("blur", onBlur);
  apply(document.hasFocus());
  return () => {
    window.removeEventListener("focus", onFocus);
    window.removeEventListener("blur", onBlur);
  };
}
