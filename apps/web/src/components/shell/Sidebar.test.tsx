// @vitest-environment jsdom
//
// #416: sidebar rows carry a small round avatar (people) or a tinted # token
// (channels), each with the member-list status-dot treatment, alongside — not
// instead of — the row's existing dot and colouring. The sidebarAvatars pref
// turns the whole treatment off, restoring the denser text-only rows.

import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { PREFS_DEFAULTS, type UserPrefs } from "@emberchat/protocol";
import { Sidebar } from "./Sidebar.js";
import type {
  ChannelView,
  DmView,
  IdentitySession,
} from "../../stores/sessions.js";

// The social sections fetch on mount; the rows under test come from the
// session snapshot, so the network call is stubbed out.
vi.mock("../../lib/social.js", () => ({
  loadSocial: () => Promise.resolve(),
}));

function channel(key: string, title: string): ChannelView {
  return {
    convId: `conv-${key}`,
    key,
    title,
    description: "",
    mode: "both",
    oplist: [],
    members: [],
    seen: [],
    joined: true,
    pinned: false,
    unread: 0,
    mentions: 0,
    highlightedAt: 0,
    lastReadMessageId: null,
    newestMessageId: null,
  };
}

function dm(partner: string, pinned = false): DmView {
  return {
    convId: `dm-${partner}`,
    partner,
    title: partner,
    online: true,
    status: "online",
    statusmsg: "",
    pinned,
    typing: "clear",
    unread: 0,
    highlightedAt: 0,
    lastReadMessageId: null,
    newestMessageId: null,
  };
}

function session(
  prefs: Partial<UserPrefs> = {},
  dms: Record<string, DmView> = { "dm-Bea": dm("Bea") },
): IdentitySession {
  return {
    identityId: "id-1",
    character: "Amber Vale",
    sessionStatus: "online",
    ownStatus: "online",
    ownStatusmsg: "",
    ignores: [],
    invites: [],
    limits: { chatMax: 4096, privMax: 50000, lfrpMax: 50000, lfrpFlood: 600 },
    iconBlacklist: [],
    chatop: false,
    sendDelaySeconds: 0,
    prefs: { ...PREFS_DEFAULTS, ...prefs },
    outbox: [],
    campaign: null,
    channels: {
      Frontpage: channel("Frontpage", "Frontpage"),
      "ADH-abc123": channel("ADH-abc123", "Quiet Room"),
    },
    dms,
    channelByConvId: {},
    synced: true,
    social: {
      friends: [{ name: "Cy", online: true, status: "online", statusmsg: "" }],
      bookmarks: [
        { name: "Dot", online: true, status: "away", statusmsg: "brb" },
      ],
      incoming: [],
      outgoing: [],
      fetchedAt: 0,
    },
  };
}

function renderSidebar(
  prefs?: Partial<UserPrefs>,
  dms?: Record<string, DmView>,
) {
  return render(
    <MemoryRouter>
      <Sidebar session={session(prefs, dms)} activeConvId={undefined} />
    </MemoryRouter>,
  );
}

const pins = (row: HTMLElement) =>
  row.querySelectorAll("span[class*='navPin']");

describe("Sidebar avatars (#416)", () => {
  it("gives DM, friend and bookmark rows an avatar with a status dot", () => {
    renderSidebar();

    const avatars = screen.getAllByTestId("sidebar-avatar");
    // One each for the DM (Bea), the friend (Cy) and the bookmark (Dot).
    expect(avatars).toHaveLength(3);
    for (const avatar of avatars) {
      expect(avatar.querySelector("img")).not.toBeNull();
      // The dot rides on the avatar, matching the member-list treatment.
      expect(avatar.childElementCount).toBe(2);
    }
  });

  it("keeps the row's own status dot alongside the avatar", () => {
    renderSidebar();

    const row = screen.getByRole("link", { name: /Bea/ });
    // Avatar dot + the row dot that was already there.
    expect(within(row).getAllByTestId("sidebar-avatar")).toHaveLength(1);
    expect(row.querySelectorAll("span[class*='navDot']")).toHaveLength(1);
  });

  it("tints channel tokens differently for official and private rooms", () => {
    renderSidebar();

    const tokens = screen.getAllByTestId("sidebar-token");
    const kinds = tokens.map((token) => token.dataset["kind"]);
    expect(kinds).toContain("official");
    expect(kinds).toContain("private");
    for (const token of tokens) {
      expect(token.textContent).toBe("#");
    }
    // The token replaces the bare # glyph rather than doubling it.
    expect(tokens[0]?.className).not.toBe(tokens[1]?.className);
  });

  it("drops avatars and tokens when the pref is off", () => {
    renderSidebar({ sidebarAvatars: false });

    expect(screen.queryByTestId("sidebar-avatar")).toBeNull();
    expect(screen.queryByTestId("sidebar-token")).toBeNull();
    // Rows still render, with the text-only channel glyph.
    expect(screen.getByRole("link", { name: /Bea/ })).toBeTruthy();
    expect(screen.getByRole("link", { name: /Frontpage/ })).toBeTruthy();
  });
});

// A friend/bookmark with an open DM keeps only their social row (#290), so
// that row has to carry the DM's pin marker too — otherwise pinning a DM and
// then befriending the partner drops the cue, along with the visible reason
// the row survives the offline filter.
describe("Sidebar pin marker on social rows", () => {
  it("marks a friend whose DM is pinned", () => {
    renderSidebar(undefined, { "dm-Cy": dm("Cy", true) });

    const row = screen.getByRole("button", { name: /Cy/ });
    expect(pins(row)).toHaveLength(1);
    // The friend row replaces the Direct messages row, not doubles it.
    expect(screen.queryByRole("link", { name: /Cy/ })).toBeNull();
  });

  it("marks a bookmark whose DM is pinned and leaves unpinned rows bare", () => {
    renderSidebar(undefined, {
      "dm-Cy": dm("Cy"),
      "dm-Dot": dm("Dot", true),
    });

    expect(pins(screen.getByRole("button", { name: /Dot/ }))).toHaveLength(1);
    expect(pins(screen.getByRole("button", { name: /Cy/ }))).toHaveLength(0);
  });

  it("leaves a social row without a DM unmarked", () => {
    renderSidebar();

    expect(pins(screen.getByRole("button", { name: /Cy/ }))).toHaveLength(0);
    expect(pins(screen.getByRole("button", { name: /Dot/ }))).toHaveLength(0);
  });
});
