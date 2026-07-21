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
