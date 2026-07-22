// UI state that other modules need to read outside React (dispatch checks
// the active conversation to decide unread bumps; the socket reports its own
// connection state). Panel/dialog state joins here as it appears.

import { create } from "zustand";
import { persistDmSidebarOpen, savedDmSidebarOpen } from "../lib/dm-sidebar.js";

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
  /** DM profile sidebar — the persisted global open preference (header ◨ /
   * sidebar » toggle). Governs the wide-window grid column (#170). */
  dmSidebarOpen: boolean;
  /** DM profile sidebar as a right-edge overlay drawer on narrow windows —
   * transient (never persisted) and always starts closed (#170). */
  dmDrawerOpen: boolean;
  /** Preferences window (COMPONENTS.md §12), opened from the MeBar gear. */
  prefsOpen: boolean;
  /** Channel browser dialog (COMPONENTS.md §11), opened from the sidebar
   * Channels section. */
  channelBrowserOpen: boolean;
  /** In-log search panel (M9), opened from the conversation header. */
  searchOpen: boolean;
  /** Quick-switcher palette (M9), toggled by Ctrl/Cmd+K. */
  switcherOpen: boolean;
  /** Ad Center modal (M10), opened from the composer's Ad button. */
  adCenterOpen: boolean;
  /** Post Ads dialog (M10), opened from the Ad Center. */
  postAdsOpen: boolean;
  /** The campaign (ad rotation) dialog (M11). */
  campaignOpen: boolean;
  /** Character-search dialog (M10), beside the channel browser. */
  characterSearchOpen: boolean;

  setActive: (
    identityId: string | undefined,
    convId: string | undefined,
  ) => void;
  setLastConv: (identityId: string, suffix: string) => void;
  setGatewayStatus: (status: GatewayConnectionStatus) => void;
  toggleMembers: () => void;
  toggleDmSidebar: () => void;
  setDmSidebarOpen: (open: boolean) => void;
  toggleDmDrawer: () => void;
  setDmDrawerOpen: (open: boolean) => void;
  setPrefsOpen: (open: boolean) => void;
  setChannelBrowserOpen: (open: boolean) => void;
  setSearchOpen: (open: boolean) => void;
  setSwitcherOpen: (open: boolean) => void;
  setAdCenterOpen: (open: boolean) => void;
  setPostAdsOpen: (open: boolean) => void;
  setCampaignOpen: (open: boolean) => void;
  setCharacterSearchOpen: (open: boolean) => void;
}

export const useUiStore = create<UiState>()((set) => ({
  activeIdentityId: undefined,
  activeConvId: undefined,
  lastConvByIdentity: {},
  gatewayStatus: "offline",
  membersOpen: true,
  dmSidebarOpen: savedDmSidebarOpen(),
  dmDrawerOpen: false,
  prefsOpen: false,
  channelBrowserOpen: false,
  searchOpen: false,
  switcherOpen: false,
  adCenterOpen: false,
  postAdsOpen: false,
  campaignOpen: false,
  characterSearchOpen: false,

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
  toggleDmSidebar() {
    set((state) => {
      const dmSidebarOpen = !state.dmSidebarOpen;
      persistDmSidebarOpen(dmSidebarOpen);
      return { dmSidebarOpen };
    });
  },
  setDmSidebarOpen(open) {
    persistDmSidebarOpen(open);
    set({ dmSidebarOpen: open });
  },
  toggleDmDrawer() {
    set((state) => ({ dmDrawerOpen: !state.dmDrawerOpen }));
  },
  setDmDrawerOpen(open) {
    set({ dmDrawerOpen: open });
  },
  setPrefsOpen(open) {
    set({ prefsOpen: open });
  },
  setChannelBrowserOpen(open) {
    set({ channelBrowserOpen: open });
  },
  setSearchOpen(open) {
    set({ searchOpen: open });
  },
  setSwitcherOpen(open) {
    set({ switcherOpen: open });
  },
  setAdCenterOpen(open) {
    set({ adCenterOpen: open });
  },
  setCampaignOpen(open) {
    set({ campaignOpen: open });
  },
  setPostAdsOpen(open) {
    set({ postAdsOpen: open });
  },
  setCharacterSearchOpen(open) {
    set({ characterSearchOpen: open });
  },
}));
