// Identity-rail visibility store (issue #346). Holds the per-device hide
// preference toggled by clicking your own avatar; a small dedicated store,
// mirroring the manual persist pattern the DM sidebar uses (no persist
// middleware anywhere in this app). The effective visibility — which also
// forces the rail visible while a second identity is connected — is derived
// with railHidden() at the read site, so this store only owns the raw pref.

import { create } from "zustand";
import { persistRailHidden, savedRailHidden } from "../lib/rail-visibility.js";

interface RailState {
  /** The stored preference: true = the user hid the rail. */
  hidden: boolean;
  toggle: () => void;
  setHidden: (hidden: boolean) => void;
}

export const useRailStore = create<RailState>()((set) => ({
  // Read synchronously at store init so the shell's first render is already in
  // its final shape — no flash before first paint.
  hidden: savedRailHidden(),
  toggle() {
    set((state) => {
      const hidden = !state.hidden;
      persistRailHidden(hidden);
      return { hidden };
    });
  },
  setHidden(hidden) {
    persistRailHidden(hidden);
    set({ hidden });
  },
}));
