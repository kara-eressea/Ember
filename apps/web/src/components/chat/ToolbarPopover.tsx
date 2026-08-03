// The popover shell both toolbars hang their menus in: an overlay to close,
// measured + viewport-clamped placement (the profile popover primitive), and a
// place on the shared Escape stack. Lifted out of ComposerToolbar (#205) when
// the conversation toolbar grew a ⋯ overflow of its own (#375) — the two rows
// keep separate collapse rules, but a menu is a menu.

import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import {
  placePopoverInWindow,
  type PopoverPlacement,
} from "../profile/popover.js";
import { useEscapeToClose } from "../../lib/useEscapeToClose.js";
import type { CardAnchor } from "../../stores/profile.js";
import styles from "./chat.module.css";

/** The anchor rect of the element a popover hangs off. */
export function anchorOf(element: HTMLElement): CardAnchor {
  const rect = element.getBoundingClientRect();
  return {
    top: rect.top,
    left: rect.left,
    bottom: rect.bottom,
    right: rect.right,
  };
}

export function ToolbarPopover({
  anchor,
  label,
  onClose,
  children,
}: {
  anchor: CardAnchor;
  label?: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState<PopoverPlacement>();
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) {
      return;
    }
    setPlacement(
      placePopoverInWindow(anchor, {
        width: element.offsetWidth,
        height: element.offsetHeight,
      }),
    );
  }, [anchor]);
  // Shared Escape stack (#442): a picker opened from inside this popover (the
  // eicon picker) mounts later and closes first, one press at a time.
  useEscapeToClose(onClose);
  return (
    <>
      <div className={styles.tbOverlay} onClick={onClose} />
      <div
        ref={ref}
        role="dialog"
        aria-label={label}
        className={styles.tbPopover}
        data-eb-surface
        style={
          placement
            ? { top: placement.top, left: placement.left }
            : { top: 0, left: 0, visibility: "hidden" }
        }
      >
        {children}
      </div>
    </>
  );
}
