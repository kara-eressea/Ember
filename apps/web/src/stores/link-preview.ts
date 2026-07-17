// Link-preview state (M8 step 13): the one open preview panel — chips
// anywhere in the log (or a profile body) open it, the AppShell-level
// host renders it. Only one preview at a time (§2).

import { create } from "zustand";
import type { PreviewSource } from "../lib/link-preview.js";
import type { CardAnchor } from "./profile.js";

interface LinkPreviewState {
  preview:
    | {
        source: PreviewSource;
        href: string;
        anchor: CardAnchor;
        /** Hover previews dismiss on mouseleave, not via an overlay. */
        mode: "click" | "hover";
      }
    | undefined;
  open: (
    source: PreviewSource,
    href: string,
    anchor: CardAnchor,
    mode: "click" | "hover",
  ) => void;
  close: () => void;
}

export const useLinkPreviewStore = create<LinkPreviewState>()((set) => ({
  preview: undefined,
  open(source, href, anchor, mode) {
    set({ preview: { source, href, anchor, mode } });
  },
  close() {
    set({ preview: undefined });
  },
}));

/** Open (or move) the preview anchored to a chip element. */
export function openPreviewFrom(
  element: Element,
  source: PreviewSource,
  href: string,
  mode: "click" | "hover",
): void {
  const rect = element.getBoundingClientRect();
  useLinkPreviewStore.getState().open(
    source,
    href,
    {
      top: rect.top,
      left: rect.left,
      bottom: rect.bottom,
      right: rect.right,
    },
    mode,
  );
}
