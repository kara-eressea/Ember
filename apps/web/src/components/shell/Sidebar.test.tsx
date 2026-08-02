// @vitest-environment jsdom
//
// #416: sidebar rows carry a small round avatar (people) or a tinted # token
// (channels), each with the member-list status-dot treatment, alongside — not
// instead of — the row's existing dot and colouring. The sidebarAvatars pref
// turns the whole treatment off, restoring the denser text-only rows.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { PREFS_DEFAULTS, type UserPrefs } from "@emberchat/protocol";
import { Sidebar } from "./Sidebar.js";
import { gateway } from "../../gateway/socket.js";
import { useUiStore } from "../../stores/ui.js";
import { appConfig } from "../../lib/config.js";
import type { MetaDto } from "../../lib/api.js";
import type {
  ChannelView,
  DmView,
  IdentitySession,
  SocialCharacter,
  SocialData,
} from "../../stores/sessions.js";

// The social sections fetch on mount; the rows under test come from the
// session snapshot, so the network call is stubbed out.
vi.mock("../../lib/social.js", () => ({
  loadSocial: () => Promise.resolve(),
}));

// The head's version comes from /api/meta — driven per test, never fetched.
const meta = vi.hoisted(() => ({ current: undefined as MetaDto | undefined }));
vi.mock("../../lib/use-meta.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/use-meta.js")>()),
  useServerMeta: () => meta.current,
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

function dm(
  partner: string,
  pinned = false,
  extra: Partial<DmView> = {},
): DmView {
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
    ...extra,
  };
}

function session(
  prefs: Partial<UserPrefs> = {},
  dms: Record<string, DmView> = { "dm-Bea": dm("Bea") },
  social: Partial<SocialData> = {},
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
      ...social,
    },
  };
}

function renderSidebar(
  prefs?: Partial<UserPrefs>,
  dms?: Record<string, DmView>,
  social?: Partial<SocialData>,
) {
  // A connected gateway is the quiet case — the head's offline chip has its
  // own test below.
  useUiStore.setState({ gatewayStatus: "online" });
  return render(
    <MemoryRouter>
      <Sidebar session={session(prefs, dms, social)} activeConvId={undefined} />
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

// Unread DM traffic floats a friend/bookmark to the top of its own section
// (#462) — with one row per character (#290) that social row is the only
// surface the unread has, so it must not stay buried in the alphabet.
describe("Sidebar activity bump on social rows (#462)", () => {
  const person = (name: string, online = true): SocialCharacter => ({
    name,
    online,
    status: online ? "online" : "offline",
    statusmsg: "",
  });

  /** Friend then bookmark rows, in rendered order. */
  const socialNames = (container: HTMLElement) =>
    Array.from(container.querySelectorAll("button[class*='socialRow']")).map(
      (row) => row.querySelector("span[class*='navLabel']")?.textContent,
    );

  const trio = {
    friends: [person("Ana"), person("Bo"), person("Cass")],
    bookmarks: [],
  };

  it("floats an unread friend above the online ones, offline or not", () => {
    const { container } = renderSidebar(
      undefined,
      { "dm-Zed": dm("Zed", false, { unread: 2, online: false }) },
      {
        friends: [person("Ana"), person("Bo"), person("Zed", false)],
        bookmarks: [],
      },
    );

    // Presence would have put the offline Zed last (#164) — and hidden them
    // outright but for the unread exemption (#329).
    expect(socialNames(container)).toEqual(["Zed", "Ana", "Bo"]);
  });

  it("orders several unread rows by their DM's highlight recency", () => {
    const { container } = renderSidebar(
      undefined,
      {
        "dm-Ana": dm("Ana", false, { unread: 1, highlightedAt: 200 }),
        "dm-Cass": dm("Cass", false, { unread: 3, highlightedAt: 100 }),
      },
      trio,
    );

    expect(socialNames(container)).toEqual(["Ana", "Cass", "Bo"]);
  });

  it("falls back to the newest message id when no highlight stamped", () => {
    const { container } = renderSidebar(
      undefined,
      {
        "dm-Ana": dm("Ana", false, { unread: 1, newestMessageId: 5 }),
        "dm-Cass": dm("Cass", false, { unread: 1, newestMessageId: 9 }),
      },
      trio,
    );

    expect(socialNames(container)).toEqual(["Cass", "Ana", "Bo"]);
  });

  it("bumps a bookmark within its own section only", () => {
    const { container } = renderSidebar(
      undefined,
      { "dm-Fen": dm("Fen", false, { unread: 1 }) },
      {
        friends: [person("Ana")],
        bookmarks: [person("Dee"), person("Eve"), person("Fen")],
      },
    );

    // The friend section keeps its own order; Fen rises inside Bookmarks.
    expect(socialNames(container)).toEqual(["Ana", "Fen", "Dee", "Eve"]);
  });

  it("returns the row to its base order once the DM is read", () => {
    const { container } = renderSidebar(
      undefined,
      { "dm-Cass": dm("Cass", false, { unread: 0, highlightedAt: 0 }) },
      trio,
    );

    expect(socialNames(container)).toEqual(["Ana", "Bo", "Cass"]);
  });
});

// The head is brand + version only: presence already lives on the identity
// rail and the MeBar, and a newer release announces itself by tinting the
// version into a link — nothing louder.
describe("Sidebar head", () => {
  const releasesUrl = "https://example.invalid/releases";

  afterEach(() => {
    meta.current = undefined;
  });

  const head = (container: HTMLElement) =>
    container.querySelector("div[class*='serverHead']");

  it("shows the app name and the running version, and no presence", () => {
    meta.current = { version: "0.19.1", updateAvailable: false, releasesUrl };
    const { container } = renderSidebar();

    expect(head(container)?.textContent).toBe(`${appConfig().appName}v0.19.1`);
    // No presence dot, no character/status line.
    expect(
      head(container)?.querySelector("span[class*='serverDot']"),
    ).toBeNull();
    expect(head(container)?.textContent).not.toContain("Amber Vale");
  });

  // The head no longer carries "«Character» · online", so the E2E suite reads
  // "the session is online" off the MeBar: its character, plus the status
  // control that unlocks only once the session connects. This pins that
  // contract — the specs relying on it can't run in jsdom.
  it("leaves the character and the session signal to the MeBar", () => {
    const { container } = renderSidebar();

    const meBar = container.querySelector<HTMLElement>(
      "[data-testid='me-bar']",
    );
    expect(meBar).not.toBeNull();
    expect(meBar?.textContent).toContain("Amber Vale");
    expect(
      within(meBar!).getByRole("button", { name: "Set status" }),
    ).toBeEnabled();

    // …and locked before then, or the E2E wait would pass instantly and stop
    // testing anything.
    cleanup();
    render(
      <MemoryRouter>
        <Sidebar
          session={{ ...session(), sessionStatus: "connecting" }}
          activeConvId={undefined}
        />
      </MemoryRouter>,
    );
    expect(screen.getByRole("button", { name: "Set status" })).toBeDisabled();
  });

  // Belt and braces for the sleep/wake family: whatever state the socket
  // talked itself into, one click retries it.
  it("offers a clickable retry while the gateway is not connected", async () => {
    const reconnect = vi
      .spyOn(gateway, "reconnectNow")
      .mockImplementation(() => undefined);
    renderSidebar();
    expect(screen.queryByRole("button", { name: "Reconnect now" })).toBeNull();

    useUiStore.setState({ gatewayStatus: "offline" });
    const chip = await screen.findByRole("button", { name: "Reconnect now" });
    expect(chip.textContent).toBe("Offline");

    chip.click();
    expect(reconnect).toHaveBeenCalledTimes(1);
    reconnect.mockRestore();
  });

  it("renders a dev version string as-is", () => {
    meta.current = {
      version: "0.0.0-dev",
      updateAvailable: false,
      releasesUrl,
    };
    const { container } = renderSidebar();

    expect(head(container)?.textContent).toContain("v0.0.0-dev");
  });

  it("links the version to the releases page when an update is waiting", () => {
    meta.current = {
      version: "0.19.1",
      updateAvailable: true,
      latestVersion: "v0.19.2",
      releasesUrl,
    };
    const { container } = renderSidebar();

    const link = container.querySelector<HTMLAnchorElement>(
      "a[class*='serverVersionUpdate']",
    );
    expect(link?.textContent).toBe("v0.19.1");
    expect(link?.title).toBe("v0.19.2 available");
    expect(
      screen.getByRole("link", { name: "Version v0.19.1 — v0.19.2 available" }),
    ).toBe(link);
    expect(link?.href).toBe(releasesUrl);
    expect(link?.target).toBe("_blank");
    expect(link?.rel).toBe("noopener noreferrer");
  });

  it("stays plain text when current, and bare while meta is unknown", () => {
    meta.current = { version: "0.19.1", updateAvailable: false, releasesUrl };
    const { container } = renderSidebar();
    expect(
      container.querySelector("a[class*='serverVersionUpdate']"),
    ).toBeNull();
    expect(
      container.querySelector("span[class*='serverVersion']"),
    ).not.toBeNull();

    meta.current = undefined;
    const unknown = renderSidebar().container;
    expect(head(unknown)?.textContent).toBe(appConfig().appName);
    expect(head(unknown)?.querySelector("[class*='serverVersion']")).toBeNull();
  });
});
