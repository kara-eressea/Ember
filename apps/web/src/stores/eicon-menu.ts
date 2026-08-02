// The one open eicon right-click menu. Eicons render deep inside virtualized
// message rows and inside the picker popover, so — like the link preview —
// the menu is state here and an AppShell-level host paints it, rather than a
// fixed popover mounted inside a clipping ancestor.

import { create } from "zustand";

interface EiconMenuState {
  menu: { name: string; point: { x: number; y: number } } | undefined;
  open: (name: string, point: { x: number; y: number }) => void;
  close: () => void;
}

export const useEiconMenuStore = create<EiconMenuState>()((set) => ({
  menu: undefined,
  open(name, point) {
    set({ menu: { name, point } });
  },
  close() {
    set({ menu: undefined });
  },
}));

/**
 * Open the menu for `name` at the pointer. Claims the event so the eicon's
 * menu wins over any surrounding surface's contextmenu handler (and over the
 * browser's own) — on the eicon element only; the rest of the surface keeps
 * whatever menu it had.
 */
export function openEiconMenu(
  event: { preventDefault: () => void; stopPropagation: () => void } & {
    clientX: number;
    clientY: number;
  },
  name: string,
): void {
  event.preventDefault();
  event.stopPropagation();
  useEiconMenuStore
    .getState()
    .open(name, { x: event.clientX, y: event.clientY });
}
