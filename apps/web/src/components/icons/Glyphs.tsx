// Shared chrome glyphs — inline SVG at the IconBtn standard (17px in a 30px
// hit target, viewBox 0 0 24 24, 1.7 stroke in currentColor), matching the
// composer toolbar's `svg()` so magnifiers, gears and power toggles read at
// the same weight everywhere instead of relying on undersized Unicode glyphs
// (COMPONENTS.md §IconBtn; issue #232).

import type { ReactNode } from "react";

function svg(children: ReactNode): ReactNode {
  return (
    <svg
      width="17"
      height="17"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {children}
    </svg>
  );
}

/** Magnifier — replaces the small `⌕` glyph on search affordances. */
export function SearchGlyph(): ReactNode {
  return svg(
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="M21 21l-4.35-4.35" />
    </>,
  );
}

/** Settings gear — replaces the small `⚙` glyph on the preferences button. */
export function GearGlyph(): ReactNode {
  return svg(
    <>
      <circle cx="12" cy="12" r="3.2" />
      <path d="M12 3.5v2.6M12 17.9v2.6M4.7 4.7l1.85 1.85M16.45 16.45l1.85 1.85M3.5 12h2.6M17.9 12h2.6M4.7 19.3l1.85-1.85M16.45 7.55l1.85-1.85" />
    </>,
  );
}

/** Power toggle — replaces the `⏻` glyph on the connect/log-off button. */
export function PowerGlyph(): ReactNode {
  return svg(
    <>
      <path d="M12 3.5v8" />
      <path d="M6.8 7.2a8 8 0 1 0 10.4 0" />
    </>,
  );
}

/* The conversation toolbar (COMPONENTS.md §5) runs on the same IconBtn spec
 * as the composer toolbar, which forbids system emoji — these replace the
 * ⚲ 🔔 ⊘ ☰ ◨ ⋮ ✕ characters the header used to render. */

/** Pin — a thumbtack, for "rejoin/reopen this on connect". */
export function PinGlyph(): ReactNode {
  return svg(
    <>
      <path d="M9 3.6h6" />
      <path d="M10 3.6v6.2l-2.8 3v1.1h9.6v-1.1l-2.8-3V3.6" />
      <path d="M12 13.9v6.5" />
    </>,
  );
}

/** Bell — per-conversation alerts on. */
export function BellGlyph(): ReactNode {
  return svg(
    <>
      <path d="M6.2 10a5.8 5.8 0 0 1 11.6 0c0 3.6 1.2 5 1.9 5.8H4.3c.7-.8 1.9-2.2 1.9-5.8Z" />
      <path d="M10.1 18.6a2 2 0 0 0 3.8 0" />
    </>,
  );
}

/** Bell with a slash — muted. A distinct glyph, not just a toggled bell:
 * the off state has to read without relying on the accent fill alone. */
export function BellOffGlyph(): ReactNode {
  return svg(
    <>
      <path d="M6.2 10a5.8 5.8 0 0 1 11.6 0c0 3.6 1.2 5 1.9 5.8H4.3c.7-.8 1.9-2.2 1.9-5.8Z" />
      <path d="M10.1 18.6a2 2 0 0 0 3.8 0" />
      <path d="M4 4l16 16" />
    </>,
  );
}

/**
 * Paper tray — the notification inbox (#466). Deliberately not a bell: the
 * bell is the per-conversation mute toggle two chips away, and two bells in
 * one cluster meaning opposite things is the sort of thing nobody unlearns.
 * A tray reads as "things that arrived and stayed", which is what the inbox
 * is: a log, not an alert.
 */
export function InboxGlyph(): ReactNode {
  return svg(
    <>
      <path d="M3.6 13.2h4.1l1.3 2.2h6l1.3-2.2h4.1" />
      <path d="M6.2 4.8h11.6l2.6 8.4v4.2a1.8 1.8 0 0 1-1.8 1.8H5.4a1.8 1.8 0 0 1-1.8-1.8v-4.2Z" />
    </>,
  );
}

/** Circle-slash — the ignore toggle (a danger action, tinted by CSS). */
export function BanGlyph(): ReactNode {
  return svg(
    <>
      <circle cx="12" cy="12" r="8.4" />
      <path d="M6.1 6.1l11.8 11.8" />
    </>,
  );
}

/** Two figures — the member-list toggle, paired with the mono count. */
export function MembersGlyph(): ReactNode {
  return svg(
    <>
      <circle cx="9.6" cy="8.4" r="3.2" />
      <path d="M3.8 19v-1.2a4 4 0 0 1 4-4h3.6a4 4 0 0 1 4 4V19" />
      <path d="M16.4 5.6a3.2 3.2 0 0 1 0 5.6" />
      <path d="M17.6 13.9a4 4 0 0 1 2.6 3.7V19" />
    </>,
  );
}

/** A panel with its right column split off — the DM profile-panel toggle. */
export function PanelRightGlyph(): ReactNode {
  return svg(
    <>
      <rect x="3.4" y="4.4" width="17.2" height="15.2" rx="2.4" />
      <path d="M14.6 4.4v15.2" />
    </>,
  );
}

/** Vertical ellipsis — opens the conversation's context menu. */
export function MoreGlyph(): ReactNode {
  return svg(
    <>
      <circle cx="12" cy="5.6" r="1.35" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.35" fill="currentColor" stroke="none" />
      <circle cx="12" cy="18.4" r="1.35" fill="currentColor" stroke="none" />
    </>,
  );
}

/** Clock face — the DM partner's local time (#439). */
export function ClockGlyph(): ReactNode {
  return svg(
    <>
      <circle cx="12" cy="12" r="8.4" />
      <path d="M12 7.4V12l3.1 2" />
    </>,
  );
}

/** Cross — closes the conversation window. */
export function CloseGlyph(): ReactNode {
  return svg(<path d="M6.4 6.4l11.2 11.2M17.6 6.4L6.4 17.6" />);
}
