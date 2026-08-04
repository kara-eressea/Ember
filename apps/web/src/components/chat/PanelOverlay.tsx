// The phone tier's right-hand panels (MP1 package D, #375). On `phone` there
// is no right-hand track to dock into, so the member list and the DM profile
// open as a full-height overlay over the conversation instead — one shell for
// both, because they are the same gesture on the same slot.
//
// It is the DM drawer generalised (dm-sidebar.module.css `.overlay`, the shim
// #170 left for narrow windows): same right-edge geometry, same backdrop. What
// it adds is what a surface covering the only pane on screen has to have and
// an ambient drawer beside a two-column layout does not — `aria-modal` with a
// focus trap (Tab stays inside, focus returns to the opener) and a place on
// the shared Escape stack as an `overlay`, so a popover opened from inside it
// still takes the first press. The compact drawer keeps its own shim rather
// than being folded in here: making it modal would change how compact behaves,
// and MP1's invariant is that only `phone` moves.
//
// The panels themselves need no phone-specific mode. Their docked form — a
// full-height flex column that fills its slot — is exactly what belongs
// inside, so this renders them as they are and supplies the chrome the docked
// column gets from the conversation toolbar spanning it: a title and a way
// out.

import { useRef, type ReactNode } from "react";
import { useEscapeToClose } from "../../lib/useEscapeToClose.js";
import { useFocusTrap } from "../../lib/useFocusTrap.js";
import styles from "./panel-overlay.module.css";

export function PanelOverlay({
  label,
  onClose,
  children,
}: {
  /** Names the surface for the accessibility tree, and heads it in the UI. */
  label: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useFocusTrap(ref);
  useEscapeToClose(onClose);

  return (
    <>
      {/* Tapping beside the panel closes it — the sliver of conversation left
          showing is the target, and it reads as "put this away" on a sheet
          this size. */}
      <div className={styles.backdrop} onClick={onClose} aria-hidden />
      <div
        ref={ref}
        className={styles.panel}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
      >
        <div className={styles.head}>
          <span className={styles.title}>{label}</span>
          <button
            type="button"
            className={styles.close}
            aria-label={`Close ${label}`}
            title={`Close ${label}`}
            onClick={onClose}
          >
            ✕
          </button>
        </div>
        <div className={styles.body}>{children}</div>
      </div>
    </>
  );
}
