// The interface-scale factor, in one place (#388). The uiScale pref puts a
// `zoom` on :root (theme.ts applyInterface) and mirrors the same factor into
// --eb-ui-zoom, because nothing else in the platform reports it: `zoom` is not
// readable as a number off computed style in a way we can trust, media queries
// are blind to it, and window.innerWidth keeps reporting visual pixels. Any
// code that has to reason about the viewport in the root's own CSS pixels
// divides by this — popover placement (components/profile/popover.ts) and the
// layout tiers (lib/layout-mode.ts) both do, and they must agree, so there is
// exactly one reader.

/** The interface-scale `zoom` factor on :root (theme.ts `applyInterface`).
 * Falls back to 1 for an unset, poisoned or nonsensical value. */
export function uiZoom(): number {
  const raw = Number.parseFloat(
    document.documentElement.style.getPropertyValue("--eb-ui-zoom"),
  );
  return Number.isFinite(raw) && raw > 0 ? raw : 1;
}
