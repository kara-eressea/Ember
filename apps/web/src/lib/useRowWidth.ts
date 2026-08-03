// The measured width of a toolbar row — the one piece the composer toolbar
// (#205) and the conversation toolbar (#375) genuinely share. Both never wrap
// and never scroll: they watch their own row and fold lower-priority controls
// into a `⋯` overflow as room runs out. What they *don't* share is the
// priority table or the width model behind it (six fixed clusters with
// dividers versus a per-conversation control set), so only the measurement is
// lifted here; each toolbar keeps its own pure decision module.
//
// An element-scoped width is a ResizeObserver's job — the shell's tiers are
// window-scoped and live in layout-mode.ts instead. This one is deliberately
// blind to the interface-scale zoom: it reports the row's own CSS pixels,
// which is the same space the controls inside it are measured in.

import { useEffect, useState, type RefObject } from "react";

/**
 * The content width of `ref`'s element, or `undefined` where the environment
 * can't answer — no observer yet, or a runner without ResizeObserver at all
 * (jsdom). Every caller reads `undefined` as "collapse nothing", so a
 * layout-less test renders the full row.
 */
export function useRowWidth(
  ref: RefObject<HTMLElement | null>,
): number | undefined {
  const [width, setWidth] = useState<number>();

  useEffect(() => {
    const row = ref.current;
    if (!row || typeof ResizeObserver !== "function") {
      return;
    }
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) {
        setWidth(entry.contentRect.width);
      }
    });
    observer.observe(row);
    return () => {
      observer.disconnect();
    };
  }, [ref]);

  return width;
}
