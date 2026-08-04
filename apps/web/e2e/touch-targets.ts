// Measuring a touch target (MP2 §3, #376). Two numbers per control, because
// "44 pixels" is two different questions:
//
//   own   — the extent around the control where a tap actually reaches it: the
//           run of points whose *topmost* hit-test result is the control or
//           something inside it. This is the floor's subject. A control whose
//           padding says 44px but whose left half is covered by the chip beside
//           it is not a 44px target, and only a hit test knows that.
//   claim — the extent the control's boxes cover at all, z-order ignored
//           (`elementsFromPoint` anywhere in the stack). This is the overlap
//           rule's subject: two claims that intersect are two controls fighting
//           over the same pixels, and the loser's user gets a ghost press.
//
// Both are scanned rather than read off `getBoundingClientRect`, because the
// mechanism §3 asks for is an `::after` overlay — a box with no node, which no
// rect API will ever report. A hit test sees it exactly.
//
// Lengths come back in the zoomed root's own CSS pixels: the interface-scale
// pref puts `zoom` on :root, client rects and hit-test coordinates are in the
// visual pixels that zoom produces, and the 44 in the spec is a CSS pixel of
// the layout the user is looking at. Same correction popover.ts and
// layout-mode.ts make, for the same reason.

import type { Locator, Page } from "@playwright/test";

/** The floor, in root CSS pixels (Apple HIG / WCAG 2.5.5 AAA agree on 44). */
export const TARGET_MIN_PX = 44;

/** How far past its own box a control is searched for hit area. Comfortably
 * past the widest expansion anything here needs (a 20px glyph to 44 is 12 a
 * side) so a scan that stops has stopped on the target's real edge. */
const SCAN_MARGIN_PX = 40;

export interface TargetMeasurement {
  /** Where it was found — surface name, then a readable label. */
  surface: string;
  label: string;
  /** `tag.class.class` with the CSS-module hashes stripped, for pointing a fix
   * at a stylesheet — and for matching exclusions against something that
   * survives the next edit to the stylesheet. */
  selector: string;
  /** The same class names on their own, for exact matching. */
  classes: string[];
  /** Painted box, root CSS pixels. */
  boxW: number;
  boxH: number;
  /** Tappable extent (topmost hit test). The floor applies to these. */
  ownW: number;
  ownH: number;
  /** Covered extent (any hit test). The overlap rule applies to these. */
  claim: { x: number; y: number; w: number; h: number };
}

export interface OverlapPair {
  surface: string;
  a: string;
  b: string;
  /** Area of the contested region, root CSS pixels squared. */
  area: number;
}

/**
 * Walk every interactive element inside `root` and measure it.
 *
 * Deliberately not a hand-written list of controls: a spec that names the
 * eight buttons it knows about stops catching the ninth. The walk takes
 * everything the ARIA/HTML contract says is operable, and the caller subtracts
 * a documented exclusion list from the result.
 */
export async function measureTargets(
  page: Page,
  surface: string,
  root: Locator,
): Promise<{ targets: TargetMeasurement[]; overlaps: OverlapPair[] }> {
  return root.evaluate(
    (container, args) => {
      const { surface: name, scan } = args;
      const zoom =
        Number.parseFloat(
          getComputedStyle(document.documentElement).getPropertyValue(
            "--eb-ui-zoom",
          ),
        ) || 1;

      const OPERABLE = [
        "button",
        "a[href]",
        "input:not([type='hidden'])",
        "select",
        "textarea",
        "summary",
        "[role='button']",
        "[role='link']",
        "[role='checkbox']",
        "[role='switch']",
        "[role='tab']",
        "[role='option']",
        "[role='menuitem']",
        "[role='menuitemcheckbox']",
        "[role='menuitemradio']",
        // Elements useLongPress has claimed (MP2 §1): an eicon or a name chip
        // in a message is a press target with no ARIA role of its own, and it
        // is precisely the class of target §3 warns is hardest to grow.
        "[data-eb-press]",
        // The conversation toolbar's search pill: a form that takes a click,
        // because on a narrow row it is a magnifier chip whose input has no
        // width to be clicked (chat.module.css .searchField). A pressable
        // element that is neither a button nor a link is rare enough to name
        // here rather than to widen the list for.
        "[role='search']",
      ].join(",");

      const elements = [...container.querySelectorAll<HTMLElement>(OPERABLE)]
        // aria-hidden subtrees are not offered to anyone, so they are not
        // targets; disabled controls cannot be pressed at all.
        .filter((el) => el.closest("[aria-hidden='true']") === null)
        .filter((el) => !(el as HTMLInputElement).disabled);

      /** The label a human reading the inventory would recognise it by. */
      const describe = (el: HTMLElement): string => {
        const aria = el.getAttribute("aria-label");
        const title = el.getAttribute("title");
        const text = (el.textContent ?? "").trim().replaceAll(/\s+/gu, " ");
        return (aria ?? title ?? (text === "" ? el.tagName : text)).slice(
          0,
          48,
        );
      };

      /** Class names with the CSS-module hash taken back off: vite emits
       * `_memberRow_1wz5p_1061`, and both the report and the exclusion list
       * want `memberRow` — the hash changes with every edit to the file the
       * class lives in, so anything matched against it is matched against a
       * build artefact. */
      const classesOf = (el: HTMLElement): string[] => {
        const raw = el.className;
        if (typeof raw !== "string" || raw === "") {
          return [];
        }
        return raw
          .split(/\s+/u)
          .filter((name) => name !== "")
          .map(
            (name) =>
              /^_(?<base>.+)_[\da-z]+_\d+$/iu.exec(name)?.groups?.base ?? name,
          );
      };

      /** Hit-test helpers, in visual pixels (what the DOM APIs speak). */
      const ownsPoint = (el: HTMLElement, x: number, y: number): boolean => {
        const top = document.elementFromPoint(x, y);
        return top !== null && (top === el || el.contains(top));
      };
      const claimsPoint = (el: HTMLElement, x: number, y: number): boolean =>
        document
          .elementsFromPoint(x, y)
          .some((node) => node === el || el.contains(node));

      /** March outward one pixel at a time from `from` until the predicate
       * stops holding; returns the last coordinate that held. */
      const march = (
        hit: (x: number, y: number) => boolean,
        from: { x: number; y: number },
        step: { x: number; y: number },
        limit: number,
      ): number => {
        let last = 0;
        for (let d = 1; d <= limit; d += 1) {
          if (!hit(from.x + step.x * d, from.y + step.y * d)) {
            break;
          }
          last = d;
        }
        return last;
      };

      /** The floating surface an element belongs to, or null for the shell.
       * Two controls on different layers cannot contest a region: the one
       * underneath is behind an opaque panel, where it is not only unpressable
       * but invisible, so nobody is aiming at it. (This is what stops a
       * notification row from being reported as fighting the eicon in the
       * message it is floating over.) */
      const layerOf = (el: HTMLElement): Element | null =>
        el.closest('[role="dialog"], [role="menu"], [aria-modal="true"]');

      const targets: TargetMeasurement[] = [];
      const claims: {
        el: HTMLElement;
        label: string;
        layer: Element | null;
        box: DOMRect;
      }[] = [];

      for (const el of elements) {
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) {
          continue; // not painted (collapsed, display:none ancestor)
        }
        const cx = rect.x + rect.width / 2;
        const cy = rect.y + rect.height / 2;
        // Occluded at its own centre: something is over it (a backdrop, an
        // open sheet). Not a target on this surface — it will be measured on
        // the surface where it is the thing in front.
        if (!ownsPoint(el, cx, cy)) {
          continue;
        }

        const own = (x: number, y: number) => ownsPoint(el, x, y);
        const any = (x: number, y: number) => claimsPoint(el, x, y);
        const centre = { x: cx, y: cy };
        const measure = (hit: (x: number, y: number) => boolean) => {
          const left = march(hit, centre, { x: -1, y: 0 }, scan);
          const right = march(hit, centre, { x: 1, y: 0 }, scan);
          const up = march(hit, centre, { x: 0, y: -1 }, scan);
          const down = march(hit, centre, { x: 0, y: 1 }, scan);
          return {
            x: cx - left,
            y: cy - up,
            w: left + right + 1,
            h: up + down + 1,
          };
        };

        const ownExtent = measure(own);
        const claimExtent = measure(any);
        const classes = classesOf(el);
        targets.push({
          surface: name,
          label: describe(el),
          selector: [el.tagName.toLowerCase(), ...classes].join("."),
          classes,
          boxW: rect.width / zoom,
          boxH: rect.height / zoom,
          ownW: ownExtent.w / zoom,
          ownH: ownExtent.h / zoom,
          claim: {
            x: claimExtent.x / zoom,
            y: claimExtent.y / zoom,
            w: claimExtent.w / zoom,
            h: claimExtent.h / zoom,
          },
        });
        claims.push({
          el,
          label: describe(el),
          layer: layerOf(el),
          box: new DOMRect(
            claimExtent.x,
            claimExtent.y,
            claimExtent.w,
            claimExtent.h,
          ),
        });
      }

      // Two controls contest a region when their claims intersect, they are on
      // the same layer, and neither contains the other. Nesting is not a
      // conflict: a ✕ inside a row link is deliberately inside it, and the
      // browser's own hit test settles who gets the press without any
      // ambiguity for the finger. Nor is distance: the scan window bounds each
      // claim at SCAN_MARGIN from its centre, which is also the neighbourhood
      // a ghost press can happen in — a thumb does not miss by 60px.
      const overlaps: OverlapPair[] = [];
      for (let i = 0; i < claims.length; i += 1) {
        for (let j = i + 1; j < claims.length; j += 1) {
          const a = claims[i];
          const b = claims[j];
          if (a === undefined || b === undefined) {
            continue;
          }
          if (a.el.contains(b.el) || b.el.contains(a.el)) {
            continue;
          }
          if (a.layer !== b.layer) {
            continue; // different layers — see layerOf
          }
          const w =
            Math.min(a.box.right, b.box.right) - Math.max(a.box.x, b.box.x);
          const h =
            Math.min(a.box.bottom, b.box.bottom) - Math.max(a.box.y, b.box.y);
          if (w > 0 && h > 0) {
            overlaps.push({
              surface: name,
              a: a.label,
              b: b.label,
              area: (w * h) / (zoom * zoom),
            });
          }
        }
      }

      return { targets, overlaps };
    },
    { surface, scan: SCAN_MARGIN_PX },
  );
}

/**
 * Wait for the surfaces that just opened to stop moving.
 *
 * A hit test taken mid-animation measures where a panel *was*: the member
 * overlay slides in from the right, and a sweep half a frame too early finds
 * every one of its controls off the edge of the screen and reports the surface
 * as empty. `toBeVisible()` is happy long before then — visibility is not
 * stillness. Infinite animations (the loading shimmer) are skipped, since they
 * never finish and are never what a target is riding on.
 */
export async function settleAnimations(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const running = document
      .getAnimations()
      .filter(
        (animation) =>
          animation.playState === "running" &&
          animation.effect?.getTiming().iterations !== Number.POSITIVE_INFINITY,
      )
      .map((animation) => animation.finished);
    await Promise.race([
      Promise.allSettled(running),
      // A belt-and-braces cap: an animation that never resolves must not hang
      // the sweep, and 1s is far past anything the shell plays (0.16–0.2s).
      new Promise((resolve) => setTimeout(resolve, 1000)),
    ]);
  });
}

/** Rounded to a tenth — the inventory is read by people, and a hit test that
 * lands on a fractional layout edge should not print sixteen digits. */
export function round(value: number): number {
  return Math.round(value * 10) / 10;
}
