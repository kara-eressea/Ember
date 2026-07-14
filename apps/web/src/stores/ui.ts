// UI state that other modules need to read outside React (dispatch checks
// the active conversation to decide unread bumps; the socket reports its own
// connection state). Panel/dialog state joins here as it appears.

import { create } from "zustand";

export type GatewayConnectionStatus = "connecting" | "online" | "offline";

interface UiState {
  activeIdentityId: string | undefined;
  activeConvId: string | undefined;
  /** Last conversation visited per identity, as its canonical path suffix
   * ("c/Frontpage", "dm/Nyx%20Firemane") — the rail returns there on
   * switch-back (Discord-style), instead of the empty landing pane. */
  lastConvByIdentity: Record<string, string>;
  /** The browser↔server socket, not the F-Chat session. */
  gatewayStatus: GatewayConnectionStatus;
  /** Members column visibility (header ☰ toggle). */
  membersOpen: boolean;
  /** Preferences window (COMPONENTS.md §12), opened from the MeBar gear. */
  prefsOpen: boolean;

  setActive: (
    identityId: string | undefined,
    convId: string | undefined,
  ) => void;
  setLastConv: (identityId: string, suffix: string) => void;
  setGatewayStatus: (status: GatewayConnectionStatus) => void;
  toggleMembers: () => void;
  setPrefsOpen: (open: boolean) => void;
}

export const useUiStore = create<UiState>()((set) => ({
  activeIdentityId: undefined,
  activeConvId: undefined,
  lastConvByIdentity: {},
  gatewayStatus: "offline",
  membersOpen: true,
  prefsOpen: false,

  setActive(identityId, convId) {
    set({ activeIdentityId: identityId, activeConvId: convId });
  },
  setLastConv(identityId, suffix) {
    set((state) => ({
      lastConvByIdentity: {
        ...state.lastConvByIdentity,
        [identityId]: suffix,
      },
    }));
  },
  setGatewayStatus(status) {
    set({ gatewayStatus: status });
  },
  toggleMembers() {
    set((state) => ({ membersOpen: !state.membersOpen }));
  },
  setPrefsOpen(open) {
    set({ prefsOpen: open });
  },
}));
