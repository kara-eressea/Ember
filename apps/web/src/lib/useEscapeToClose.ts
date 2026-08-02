import { useEffect, useInsertionEffect, useRef } from "react";

// Shared Escape-to-close convention for overlays (menus, popovers, drawers,
// modals). One global capture-phase listener drives a stack so that a single
// Escape:
//   - runs exactly one handler — the topmost overlay, and
//   - claims the event (preventDefault + stopImmediatePropagation) so
//     background listeners like MessageLog's jump/mark-read — which back off
//     on defaultPrevented — do not also fire, and so stacked overlays close
//     one press at a time.
//
// Capture phase + preventDefault is the established convention (the ImagesTab
// lightbox and the slash popover already rely on it); routing every overlay
// through this single stack keeps that convention from drifting and gives
// strict topmost-first ordering that sibling window listeners cannot.
//
// Mount order alone is not enough, though: an "ambient" Escape action is
// registered by a component that outlives the overlays above it and can be
// (re-)enabled while one is open — MessageLog's "mark caught up" arms itself
// the moment a message arrives, which used to push it ON TOP of an open
// profile card and eat the first Escape. So entries carry a kind, and every
// overlay outranks every ambient entry regardless of registration order.
// Within a kind it stays LIFO.

type EscapeHandler = () => void;

/** "overlay" = a surface the user opened and expects Escape to close (the
 * default). "ambient" = a background affordance that only gets Escape when
 * nothing is open. */
export type EscapeKind = "overlay" | "ambient";

interface Entry {
  kind: EscapeKind;
  run: EscapeHandler;
}

const stack: Entry[] = [];
let listening = false;

function topmost(): Entry | undefined {
  for (let i = stack.length - 1; i >= 0; i -= 1) {
    if (stack[i]?.kind === "overlay") {
      return stack[i];
    }
  }
  return stack[stack.length - 1];
}

function onKey(event: KeyboardEvent) {
  if (event.key !== "Escape") {
    return;
  }
  const entry = topmost();
  if (!entry) {
    return;
  }
  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation();
  entry.run();
}

function ensureListener() {
  if (listening) {
    return;
  }
  window.addEventListener("keydown", onKey, true);
  listening = true;
}

/**
 * Register `handler` as the Escape action for an overlay while it is mounted
 * (and `enabled`). The most recently mounted enabled overlay handles Escape
 * first and consumes the event; `kind: "ambient"` steps aside for any open
 * overlay however late it registered. The handler runs whatever dismissal
 * logic the overlay needs — it need not always fully close (e.g. collapsing a
 * nested form first) — but the event is claimed either way.
 */
export function useEscapeToClose(
  handler: EscapeHandler,
  enabled = true,
  kind: EscapeKind = "overlay",
) {
  const handlerRef = useRef(handler);
  // Keep the latest handler without re-subscribing to the stack each render.
  useInsertionEffect(() => {
    handlerRef.current = handler;
  });

  useEffect(() => {
    if (!enabled) {
      return;
    }
    ensureListener();
    const entry: Entry = { kind, run: () => handlerRef.current() };
    stack.push(entry);
    return () => {
      const index = stack.lastIndexOf(entry);
      if (index !== -1) {
        stack.splice(index, 1);
      }
    };
  }, [enabled, kind]);
}
