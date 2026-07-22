import { useEffect, useInsertionEffect, useRef } from "react";

// Shared Escape-to-close convention for overlays (menus, popovers, drawers,
// modals). One global capture-phase listener drives a mount-order stack so
// that a single Escape:
//   - closes only the topmost overlay (last mounted wins), and
//   - claims the event (preventDefault + stopImmediatePropagation) so
//     background listeners like MessageLog's jump/mark-read — which back off
//     on defaultPrevented — do not also fire, and so stacked overlays close
//     one press at a time.
//
// Capture phase + preventDefault is the established convention (the ImagesTab
// lightbox and the slash popover already rely on it); routing every overlay
// through this single stack keeps that convention from drifting and gives
// strict topmost-first ordering that sibling window listeners cannot.

type EscapeHandler = () => void;

const stack: EscapeHandler[] = [];
let listening = false;

function onKey(event: KeyboardEvent) {
  if (event.key !== "Escape") {
    return;
  }
  const handler = stack[stack.length - 1];
  if (!handler) {
    return;
  }
  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation();
  handler();
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
 * first and consumes the event. The handler runs whatever dismissal logic the
 * overlay needs — it need not always fully close (e.g. collapsing a nested
 * form first) — but the event is claimed either way.
 */
export function useEscapeToClose(handler: EscapeHandler, enabled = true) {
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
    const entry: EscapeHandler = () => handlerRef.current();
    stack.push(entry);
    return () => {
      const index = stack.lastIndexOf(entry);
      if (index !== -1) {
        stack.splice(index, 1);
      }
    };
  }, [enabled]);
}
