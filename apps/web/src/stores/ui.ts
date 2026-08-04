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
  /** Does the window have focus? Together with the active conversation this is
   * "the user is looking at this" (#440) — the gate on marking messages read.
   * Focus, not visibility: a visible but unfocused window is not attention,
   * which is exactly what desktop-notify/highlight-notify already assume.
   * Optimistic until startWindowFocusTracking() reads the real state at mount
   * (a tab opened in the background never fires a blur to correct it). */
  windowFocused: boolean;
  /** Members column visibility (header ☰ toggle) — the docked right column on
   * compact and wide. */
  membersOpen: boolean;
  /** The member list as a full-height overlay on the phone tier, where there
   * is no column to dock into (#375, MP1 package D) — transient (never
   * persisted) and always starts closed, exactly like the DM drawer below.
   * Keeping it separate from `membersOpen` is the point: that pref defaults to
   * open, and sharing it would put a member list over every conversation a
   * phone opens. */
  membersDrawerOpen: boolean;
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
  /**
   * Bumped when something asks the sidebar to show its friend-request rows
   * (the notification inbox, #467). A nonce rather than a boolean: asking
   * twice in a row must reveal twice, and there is no "off" state to clear.
   */
  friendRequestsNonce: number;

  setActive: (
    identityId: string | undefined,
    convId: string | undefined,
  ) => void;
  setLastConv: (identityId: string, suffix: string) => void;
  setGatewayStatus: (status: GatewayConnectionStatus) => void;
  setWindowFocused: (focused: boolean) => void;
  toggleMembers: () => void;
  toggleMembersDrawer: () => void;
  setMembersDrawerOpen: (open: boolean) => void;
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
  revealFriendRequests: () => void;
}

export const useUiStore = create<UiState>()((set) => ({
  activeIdentityId: undefined,
  activeConvId: undefined,
  lastConvByIdentity: {},
  gatewayStatus: "offline",
  windowFocused: true,
  membersOpen: true,
  membersDrawerOpen: false,
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
  friendRequestsNonce: 0,

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
  setWindowFocused(focused) {
    set({ windowFocused: focused });
  },
  toggleMembers() {
    set((state) => ({ membersOpen: !state.membersOpen }));
  },
  toggleMembersDrawer() {
    set((state) => ({ membersDrawerOpen: !state.membersDrawerOpen }));
  },
  setMembersDrawerOpen(open) {
    set({ membersDrawerOpen: open });
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
  revealFriendRequests() {
    set((state) => ({ friendRequestsNonce: state.friendRequestsNonce + 1 }));
  },
}));
