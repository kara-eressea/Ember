// UI state that other modules need to read outside React (dispatch checks
// the active conversation to decide unread bumps; the socket reports its own
// connection state). Panel/dialog state joins here as it appears.

import { create } from "zustand";

export type GatewayConnectionStatus = "connecting" | "online" | "offline";

interface UiState {
  activeIdentityId: string | undefined;
  activeConvId: string | undefined;
  /** Last conversation visited per identity — the rail returns there on
   * switch-back (Discord-style), instead of the empty landing pane. */
  lastConvByIdentity: Record<string, string>;
  /** The browser↔server socket, not the F-Chat session. */
  gatewayStatus: GatewayConnectionStatus;
  /** Members column visibility (header ☰ toggle). */
  membersOpen: boolean;

  setActive: (
    identityId: string | undefined,
    convId: string | undefined,
  ) => void;
  setGatewayStatus: (status: GatewayConnectionStatus) => void;
  toggleMembers: () => void;
}

export const useUiStore = create<UiState>()((set) => ({
  activeIdentityId: undefined,
  activeConvId: undefined,
  lastConvByIdentity: {},
  gatewayStatus: "offline",
  membersOpen: true,

  setActive(identityId, convId) {
    set((state) => ({
      activeIdentityId: identityId,
      activeConvId: convId,
      lastConvByIdentity:
        identityId !== undefined && convId !== undefined
          ? { ...state.lastConvByIdentity, [identityId]: convId }
          : state.lastConvByIdentity,
    }));
  },
  setGatewayStatus(status) {
    set({ gatewayStatus: status });
  },
  toggleMembers() {
    set((state) => ({ membersOpen: !state.membersOpen }));
  },
}));
