// @vitest-environment jsdom
//
// #416: sidebar rows carry a small round avatar (people) or a tinted # token
// (channels), each with the member-list status-dot treatment, alongside — not
// instead of — the row's existing dot and colouring. The sidebarAvatars pref
// turns the whole treatment off, restoring the denser text-only rows.

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { APP_NAME, PREFS_DEFAULTS, type UserPrefs } from "@emberchat/protocol";
import { Sidebar } from "./Sidebar.js";
import { gateway } from "../../gateway/socket.js";
import { useUiStore } from "../../stores/ui.js";
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
    lastActivityId: 0,
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

// Recent DM activity is the base sort for the people sections (#515), which
// retires the #462/#463 unread float: a friend you are talking to sits at the
// top whether or not their last line is still unread, so reading them clears
// the badge without the row teleporting away. With one row per character
// (#290) that social row is the only surface the conversation has.
describe("Sidebar activity sort on social rows (#515)", () => {
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

  it("lifts a recently-active friend above the online ones, offline or not", () => {
    const { container } = renderSidebar(
      undefined,
      {
        "dm-Zed": dm("Zed", false, {
          unread: 2,
          online: false,
          lastActivityId: 12,
        }),
      },
      {
        friends: [person("Ana"), person("Bo"), person("Zed", false)],
        bookmarks: [],
      },
    );

    // Presence would have put the offline Zed last (#164) — and hidden them
    // outright but for the unread exemption (#329).
    expect(socialNames(container)).toEqual(["Zed", "Ana", "Bo"]);
  });

  it("orders several conversations by their newest message id", () => {
    const { container } = renderSidebar(
      undefined,
      {
        "dm-Ana": dm("Ana", false, { unread: 1, lastActivityId: 200 }),
        "dm-Cass": dm("Cass", false, { unread: 3, lastActivityId: 100 }),
      },
      trio,
    );

    expect(socialNames(container)).toEqual(["Ana", "Cass", "Bo"]);
  });

  // The heart of #515: Cass has the older conversation but it is READ, Ana's
  // is newer. Under the retired float, Ana (unread) would have floated and
  // Cass would have sat in the alphabet; now both are ordered by recency and
  // reading Ana would change nothing.
  it("keeps a read conversation ranked by recency, above rows with none", () => {
    const { container } = renderSidebar(
      undefined,
      {
        "dm-Cass": dm("Cass", false, { unread: 0, lastActivityId: 300 }),
        "dm-Ana": dm("Ana", false, { unread: 0, lastActivityId: 100 }),
      },
      trio,
    );

    expect(socialNames(container)).toEqual(["Cass", "Ana", "Bo"]);
  });

  it("ranks a bookmark within its own section only", () => {
    const { container } = renderSidebar(
      undefined,
      { "dm-Fen": dm("Fen", false, { unread: 1, lastActivityId: 7 }) },
      {
        friends: [person("Ana")],
        bookmarks: [person("Dee"), person("Eve"), person("Fen")],
      },
    );

    // The friend section keeps its own order; Fen rises inside Bookmarks.
    expect(socialNames(container)).toEqual(["Ana", "Fen", "Dee", "Eve"]);
  });

  it("leaves rows with no conversation in presence + alphabetical order", () => {
    const { container } = renderSidebar(undefined, {}, trio);

    expect(socialNames(container)).toEqual(["Ana", "Bo", "Cass"]);
  });

  // A hand-placed order is gone with #391's people half (#515): a stored one
  // is inert rather than half-applied, so the sort below is pure activity.
  it("ignores a stored manual order for the people sections", () => {
    const { container } = renderSidebar(
      {
        sidebarOrder: {
          "id-1": { friends: ["cass", "bo", "ana"], dms: ["bea"] },
        },
      },
      { "dm-Bo": dm("Bo", false, { lastActivityId: 5 }) },
      trio,
    );

    expect(socialNames(container)).toEqual(["Bo", "Ana", "Cass"]);
  });

  it("gives people rows no drag affordance", () => {
    const { container } = renderSidebar(
      undefined,
      { "dm-Bea": dm("Bea") },
      trio,
    );

    for (const row of container.querySelectorAll(
      "button[class*='socialRow']",
    )) {
      expect(row.getAttribute("draggable")).toBeNull();
    }
    // The DM row's wrapper is not draggable either — only channels are.
    const dmWrap = screen
      .getByRole("link", { name: /Bea/ })
      .closest("div[class*='navRowWrap']");
    expect(dmWrap?.getAttribute("draggable")).toBeNull();
  });
});

// Direct messages sort the same way (#515), with pins still on top (#169).
describe("Sidebar Direct messages ordering (#515)", () => {
  const dmNames = (container: HTMLElement) =>
    Array.from(container.querySelectorAll("a[class*='navItem']"))
      .map((row) => row.querySelector("span[class*='navLabel']")?.textContent)
      .filter((label) => label != null && /^(Ana|Bea|Cass)$/.test(label));

  it("orders by recent activity, alphabetical for conversations with none", () => {
    const { container } = renderSidebar(undefined, {
      "dm-Ana": dm("Ana", false, { lastActivityId: 10 }),
      "dm-Bea": dm("Bea"),
      "dm-Cass": dm("Cass", false, { lastActivityId: 40 }),
    });

    expect(dmNames(container)).toEqual(["Cass", "Ana", "Bea"]);
  });

  it("keeps a pinned row above a more recently active one", () => {
    const { container } = renderSidebar(undefined, {
      "dm-Ana": dm("Ana", true, { lastActivityId: 1 }),
      "dm-Cass": dm("Cass", false, { lastActivityId: 99 }),
    });

    expect(dmNames(container)).toEqual(["Ana", "Cass"]);
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

    expect(head(container)?.textContent).toBe(`${APP_NAME}v0.19.1`);
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
    expect(head(unknown)?.textContent).toBe(APP_NAME);
    expect(head(unknown)?.querySelector("[class*='serverVersion']")).toBeNull();
  });
});

// A muted conversation said so nowhere in the list (#490): mute lives in
// prefs.mutedConvIds, and the only surface that read it was the conversation
// you had to open to find out. The row carries it now — a glyph in the
// trailing column, and the label down to §4's muted tone.
describe("Sidebar muted rows (#490)", () => {
  const mutes = (row: HTMLElement) =>
    row.querySelectorAll("span[class*='navMute']");
  const isMuted = (row: HTMLElement) => /mutedRow/.test(row.className);

  it("marks a muted channel row and leaves the others alone", () => {
    renderSidebar({ mutedConvIds: ["conv-ADH-abc123"] });

    const quiet = screen.getByRole("link", { name: /Quiet Room/ });
    expect(mutes(quiet)).toHaveLength(1);
    expect(isMuted(quiet)).toBe(true);

    const frontpage = screen.getByRole("link", { name: /Frontpage/ });
    expect(mutes(frontpage)).toHaveLength(0);
    expect(isMuted(frontpage)).toBe(false);
  });

  it("marks a muted DM row", () => {
    renderSidebar({ mutedConvIds: ["dm-Bea"] });

    expect(mutes(screen.getByRole("link", { name: /Bea/ }))).toHaveLength(1);
  });

  // #290 again: a friend/bookmark with an open DM keeps no row in Direct
  // messages, so their social row is the only place the mute can show.
  it("carries a muted DM onto the partner's social row", () => {
    renderSidebar({ mutedConvIds: ["dm-Cy"] }, { "dm-Cy": dm("Cy") });

    const cy = screen.getByRole("button", { name: /Cy/ });
    expect(mutes(cy)).toHaveLength(1);
    expect(isMuted(cy)).toBe(true);
    expect(mutes(screen.getByRole("button", { name: /Dot/ }))).toHaveLength(0);
  });

  it("names the marker for a screen reader", () => {
    renderSidebar({ mutedConvIds: ["conv-ADH-abc123"] });

    expect(
      within(screen.getByRole("link", { name: /Quiet Room/ })).getByRole(
        "img",
        { name: "Muted" },
      ),
    ).toBeTruthy();
  });
});

// #496: the heading used to be a button hugging its label inside a wider
// header row, so the gap after the word and the count at the far right looked
// exactly as clickable as the label and did nothing.
describe("Sidebar section headers (#496)", () => {
  // A plain string matcher is a whole-name match, so this doubles as the
  // assertion that the count never joins the button's accessible name.
  const header = (label: string) => screen.getByRole("button", { name: label });

  it("makes the whole heading row one toggle, count included", () => {
    const { container } = renderSidebar();

    const channels = header("Channels");
    // The row *is* the button: nothing sits between it and the scroller…
    expect(channels.className).toMatch(/sectionHeader/);
    expect(channels.parentElement).toBe(
      container.querySelector("div[class*='navScroll']"),
    );
    // …and the count rides inside it rather than beside it, without joining
    // the accessible name (which the whole-name lookup above already asserts).
    expect(
      channels.querySelector("span[class*='sectionMeta']")?.textContent,
    ).toBe("2");
  });

  it("collapses and expands from that row", () => {
    renderSidebar();

    const channels = header("Channels");
    expect(channels.getAttribute("aria-expanded")).toBe("true");
    expect(screen.queryByRole("link", { name: /Frontpage/ })).not.toBeNull();

    fireEvent.click(channels);
    expect(header("Channels").getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("link", { name: /Frontpage/ })).toBeNull();

    fireEvent.click(header("Channels"));
    expect(header("Channels").getAttribute("aria-expanded")).toBe("true");
    expect(screen.queryByRole("link", { name: /Frontpage/ })).not.toBeNull();
  });
});
