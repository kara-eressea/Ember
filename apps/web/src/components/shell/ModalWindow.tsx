// Shared modal-window shell (COMPONENTS.md §12): a centered dialog over a
// dimmed backdrop, used by the Preferences window and the room-settings
// window. It owns the chrome-agnostic concerns — the backdrop, focus-once,
// Escape-to-close, and backdrop-click dismissal — while each consumer styles
// and fills the window itself via `windowClassName` + children.

import { useEffect, useRef, type ReactNode } from "react";
import { useEscapeToClose } from "../../lib/useEscapeToClose.js";
import styles from "./modal.module.css";

export function ModalWindow({
  ariaLabel,
  windowClassName,
  onClose,
  children,
}: {
  ariaLabel: string;
  /** Fully styles the window box (size + chrome); a CSS-module class. */
  windowClassName: string | undefined;
  onClose: () => void;
  children: ReactNode;
}) {
  const windowRef = useRef<HTMLDivElement>(null);
  // onClose is an inline arrow in the parent, so it's a fresh reference on
  // every parent render. Keep it in a ref the mount-only effect reads, so a
  // parent re-render (a prefs-sync round trip, a presence tick) never re-runs
  // the focus effect and yanks focus out of an input the user is typing in
  // (#310).
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  useEffect(() => {
    // Focus the dialog once, on open — not on every parent render.
    windowRef.current?.focus();
  }, []);

  // Topmost-overlay-wins Escape via the shared stack (nested pickers close
  // before this window does).
  useEscapeToClose(() => {
    onCloseRef.current();
  });

  return (
    <div
      className={styles.overlay}
      onPointerDown={(event) => {
        // Backdrop only — clicks inside the window must not close it.
        if (event.target === event.currentTarget) {
          onCloseRef.current();
        }
      }}
    >
      <div
        className={windowClassName}
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
        tabIndex={-1}
        ref={windowRef}
      >
        {children}
      </div>
    </div>
  );
}
