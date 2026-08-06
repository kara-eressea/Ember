// jsdom stubs the unit tier reaches for more than twice.
//
// The e2e side already states the rule this module applies (`e2e/long-press.ts`:
// "the third copy is where a copied helper becomes a rule"); the unit tier had
// seven copies of `setWindowWidth` and four of `stubNoHover` before #559, and
// the latter had already drifted into two incompatible signatures — which is
// the failure mode the rule exists to prevent.
//
// Importable rather than global: `vitest.setup.ts` runs for every file in the
// suite, and most of the suite is pure logic under the node environment with
// no `window` to stub. A test that needs a viewport says so by importing one.

import { vi } from "vitest";
import { NO_HOVER_QUERY } from "../lib/pointer.js";

/**
 * Put the window on a width. jsdom's own `innerWidth` is a non-configurable
 * getter fixed at 1024, so this redefines the property rather than assigning
 * to it — and leaves it configurable so the next call can do the same.
 *
 * Does not dispatch `resize`: whether a change should be *observed* is the
 * test's business (some assert the tier at mount, others drive a resize
 * through `act`), and firing an event here would take that choice away.
 */
export function setWindowWidth(width: number): void {
  Object.defineProperty(window, "innerWidth", {
    value: width,
    configurable: true,
  });
}

/**
 * Install a `matchMedia` that answers the hover query.
 *
 * jsdom ships no `matchMedia` at all, which `lib/pointer.ts` reads as "this
 * pointer hovers" — the desktop answer, and the right default. Touch cases
 * have to supply one; `stubNoHover()` is the common case (a phone),
 * `stubNoHover(false)` the paired control that proves the same component
 * behaves differently on a mouse.
 *
 * Every other query answers `false`, so this is safe to install in a file
 * whose component also asks about reduced motion or colour scheme.
 * `vi.unstubAllGlobals()` in an `afterEach` removes it.
 */
export function stubNoHover(noHover = true): void {
  vi.stubGlobal(
    "matchMedia",
    (query: string): MediaQueryList =>
      ({
        matches: query === NO_HOVER_QUERY ? noHover : false,
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }) as unknown as MediaQueryList,
  );
}
