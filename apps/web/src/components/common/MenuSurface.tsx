// MenuSurface (MP2 §1, #376): the shell every context menu in the app renders
// into, and the one place that decides which shape it takes.
//
// The five menus (eicon, member, channel, section-offline, identity rail) were
// already the same popover five times over — a fixed panel at the press point
// over a click-away overlay, measured and clamped pre-paint. What MP2 adds is
// a second shape for the same menu: on the `phone` tier the panel becomes a
// full-width bottom sheet, because a 204px popover anchored at a fingertip on
// a 390px screen covers the thing it was opened on and then gets clamped to an
// edge anyway.
//
// The menus keep their items. Nothing here knows what a menu contains — the
// item list is authored once, in the menu component, as the same JSX it always
// was, and this file presents it two ways. The sheet's 44px rows and inline
// submenus are reached from the ARIA the items already carry (menu-surface.
// module.css), which is also the only selector that crosses a CSS-module
// boundary honestly.
//
// Keyed on the tier alone, not tier-and-pointer. The question the sheet
// answers is a geometric one — is there room beside the finger for a panel —
// and the tier is exactly that question, already zoom-corrected (§5-E). Keying
// it on the pointer as well would hand a mouse user in a 390px window the
// cramped anchored popover that this exists to replace, and would hand a
// tablet with a paired mouse a sheet it has the width to avoid. Above `phone`
// nothing about this file is reachable without a coarse pointer anyway: the
// recognizer that opens a menu by touch is gated on `hover: none`, and the
// right-click that opens one by mouse still lands on the anchored form.

import {
  useLayoutEffect,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { useEscapeToClose } from "../../lib/useEscapeToClose.js";
import { useFocusTrap } from "../../lib/useFocusTrap.js";
import { useLayoutMode } from "../../lib/layout-mode.js";
import { placeAtPointInWindow } from "../profile/popover.js";
import styles from "./menu-surface.module.css";

export interface MenuSurfaceProps {
  /** The anchored popover's own class — each menu keeps its look and width.
   * Typed as React types a className, because that is what these are: the
   * CSS-module lookups the callers pass in are `string | undefined`. */
  className: string | undefined;
  /** The anchored form's click-away overlay class. */
  overlayClassName: string | undefined;
  /** Names the surface for assistive tech, and heads the sheet. */
  label: string;
  /** The menu's own header element (avatar + nick, glyph + title, …). Shown
   * in both shapes; the sheet adds a ✕ beside it. */
  head: ReactNode;
  /** Where the press landed, in client pixels. */
  point: { x: number; y: number };
  onClose: () => void;
  /** What Escape does, when that is not simply "close". The member menu
   * closes one level at a time — an open submenu, then a report being
   * drafted, then the menu — and registering that here keeps one entry on the
   * shared Escape stack per open menu rather than two. */
  onEscape?: () => void;
  /** The menu's arrow-key walk. Each menu keeps its own — they differ (the
   * member menu steps aside for the report textarea, the channel menu's
   * submenu claims ArrowRight). */
  onKeyDown?: (event: ReactKeyboardEvent) => void;
  /** Anything that changes the anchored menu's measured size — a submenu
   * opening, a form expanding. The clamp re-runs when it changes. */
  reflow?: unknown;
  /** The element the menu walks for its items and initial focus. Points at
   * the `role="menu"` container in both shapes. */
  menuRef: RefObject<HTMLDivElement | null>;
  children: ReactNode;
}

export function MenuSurface(props: MenuSurfaceProps) {
  // Two components rather than a branch inside one, because the shapes differ
  // in which hooks they need: only the sheet traps focus, only the popover
  // clamps itself to a point.
  return useLayoutMode() === "phone" ? (
    <SheetMenu {...props} />
  ) : (
    <AnchoredMenu {...props} />
  );
}

/** The desktop shape, unchanged: a fixed popover at the pointer over a
 * click-away overlay. */
function AnchoredMenu({
  className,
  overlayClassName,
  label,
  head,
  point,
  onClose,
  onEscape,
  onKeyDown,
  reflow,
  menuRef,
  children,
}: MenuSurfaceProps) {
  // Clamp against the *measured* menu, written to the DOM pre-paint rather
  // than through state: the nudge must not cost a re-render.
  useLayoutEffect(() => {
    const element = menuRef.current;
    if (!element) {
      return;
    }
    const { top, left } = placeAtPointInWindow(point, {
      width: element.offsetWidth,
      height: element.offsetHeight,
    });
    element.style.left = `${String(left)}px`;
    element.style.top = `${String(top)}px`;
  }, [menuRef, point, reflow]);

  useEscapeToClose(onEscape ?? onClose);

  return (
    <>
      <div
        className={overlayClassName}
        onClick={onClose}
        onContextMenu={(event) => {
          // A right-click beside the menu dismisses it rather than being
          // silently eaten (the mini-card overlay's convention).
          event.preventDefault();
          onClose();
        }}
      />
      <div
        ref={menuRef}
        className={className}
        data-eb-surface
        role="menu"
        aria-label={label}
        style={{ left: point.x, top: point.y }}
        onKeyDown={onKeyDown}
      >
        {head}
        {children}
      </div>
    </>
  );
}

/** The phone shape: the same items as a bottom sheet. */
function SheetMenu({
  label,
  head,
  onClose,
  onEscape,
  onKeyDown,
  menuRef,
  children,
}: MenuSurfaceProps) {
  const sheetRef = useRef<HTMLDivElement>(null);
  // Modal, unlike the anchored popover: it covers the only pane on screen, so
  // Tab has to stay inside it and focus has to come back to whatever opened it
  // — the same call PanelOverlay makes for the same reason (MP1 package D).
  useFocusTrap(sheetRef);
  useEscapeToClose(onEscape ?? onClose);

  return (
    <>
      <div className={styles.backdrop} onClick={onClose} aria-hidden />
      <div
        ref={sheetRef}
        className={styles.sheet}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
      >
        <div className={styles.head}>
          {head}
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
        {/* The menu itself stays a menu inside the dialog: the items keep the
            roles they were authored with, and the arrow-key walk keeps
            working on a keyboard attached to a phone-width window. */}
        <div
          ref={menuRef}
          className={styles.items}
          role="menu"
          aria-label={label}
          onKeyDown={onKeyDown}
        >
          {children}
        </div>
      </div>
    </>
  );
}
