// @vitest-environment jsdom
//
// #350: the channel header renders the room title as plain text (an <h1>,
// never through RichText), so a server-escaped title must be decoded or it
// shows raw "&amp;". The viewer here is a non-op, so the op-only RoomChip
// (which pulls in gateway/store machinery) never mounts.

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { ChannelHeader, DmHeader } from "./ChannelHeader.js";
import { gateway } from "../../gateway/socket.js";
import { useProfileStore } from "../../stores/profile.js";
import { useUiStore } from "../../stores/ui.js";
import { setWindowWidth } from "../../test-support/dom.js";
import {
  useSessionsStore,
  type ChannelView,
  type DmView,
} from "../../stores/sessions.js";

// jsdom lays nothing out, so the row's ResizeObserver would never fire and the
// header would render everything inline forever. This stand-in hands the test
// the callback, the way the composer toolbar's own suites stub the observer
// away — except here the measurement *is* the subject, so it has to be
// drivable rather than inert.
let resize: ((width: number) => void) | undefined;
vi.stubGlobal(
  "ResizeObserver",
  class {
    readonly #callback: ResizeObserverCallback;
    constructor(callback: ResizeObserverCallback) {
      this.#callback = callback;
    }
    observe(): void {
      resize = (width: number) => {
        act(() => {
          this.#callback(
            [{ contentRect: { width } } as ResizeObserverEntry],
            this,
          );
        });
      };
    }
    unobserve(): void {}
    disconnect(): void {
      resize = undefined;
    }
  },
);

/** The measured width the row reports next. */
function measureRow(width: number) {
  if (!resize) {
    throw new Error("the header row was never observed");
  }
  resize(width);
}

// `setWindowWidth` puts the window on a tier: the header only collapses below
// `wide`, and the `phone` tier keeps exactly two chips whatever the
// measurement says.

const initialSessions = useSessionsStore.getState().sessions;
afterEach(() => {
  useSessionsStore.setState({ sessions: initialSessions });
  useProfileStore.setState({ profiles: {} });
  useUiStore.setState({ membersOpen: true, membersDrawerOpen: false });
  setWindowWidth(1024); // jsdom's default
});

function channelTitled(title: string, description = ""): ChannelView {
  return {
    convId: "c1",
    key: "Frontpage",
    title,
    description,
    mode: "both",
    // Owner is someone else → the viewer is a non-op, so no RoomChip.
    oplist: ["Someone Else"],
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

describe("ChannelHeader title entity decode (#350)", () => {
  it("renders a server-escaped room title decoded, not as raw &amp;", () => {
    render(
      <MemoryRouter>
        <ChannelHeader
          identityId="id1"
          channel={channelTitled("Canons &amp; Vibes")}
        />
      </MemoryRouter>,
    );
    expect(
      screen.getByRole("heading", { name: "Canons & Vibes" }),
    ).toBeInTheDocument();
  });
});

function dm(): DmView {
  return {
    convId: "d1",
    partner: "Wren Salloway",
    title: "Wren Salloway",
    online: true,
    status: "online",
    statusmsg: "",
    pinned: false,
    typing: "clear",
    unread: 0,
    highlightedAt: 0,
    lastReadMessageId: null,
    newestMessageId: null,
    lastActivityId: 0,
  };
}

function cacheProfile(timezone: string | null, flistOffset: number | null) {
  useProfileStore.setState({
    profiles: {
      "wren salloway": {
        state: "ok",
        response: {
          profile: { name: "Wren Salloway", timezone: flistOffset },
          note: null,
          timezone,
        },
      } as never,
    },
  });
}

describe("DM header partner clock", () => {
  it("shows the local time from the zone the user set for them", () => {
    cacheProfile("Europe/Berlin", null);
    render(
      <MemoryRouter>
        <DmHeader identityId="id1" dm={dm()} />
      </MemoryRouter>,
    );
    expect(screen.getByTitle(/local time/).getAttribute("title")).toContain(
      "Europe/Berlin (set by you)",
    );
  });

  it("falls back to the profile's own offset, and shows nothing without either", () => {
    cacheProfile(null, 2);
    const { unmount } = render(
      <MemoryRouter>
        <DmHeader identityId="id1" dm={dm()} />
      </MemoryRouter>,
    );
    expect(screen.getByTitle(/local time/).getAttribute("title")).toContain(
      "UTC+2",
    );
    unmount();

    cacheProfile(null, null);
    render(
      <MemoryRouter>
        <DmHeader identityId="id1" dm={dm()} />
      </MemoryRouter>,
    );
    expect(screen.queryByTitle(/local time/)).toBeNull();
  });
});

describe("conversation toolbar", () => {
  it("keeps every channel action on one row", () => {
    render(
      <MemoryRouter>
        <ChannelHeader identityId="id1" channel={channelTitled("Frontpage")} />
      </MemoryRouter>,
    );
    for (const name of ["Pin", "Mute conversation", "Toggle member list"]) {
      expect(screen.getByRole("button", { name })).toBeInTheDocument();
    }
    // Search is the row's one text field, not a button that opens one.
    expect(
      screen.getByRole("textbox", { name: "Search log" }),
    ).toBeInTheDocument();
  });

  it("opens the full description from the truncated topic", async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <ChannelHeader
          identityId="id1"
          channel={channelTitled(
            "Frontpage",
            "Warm glass and [b]growing things[/b].",
          )}
        />
      </MemoryRouter>,
    );
    const topic = screen.getByRole("button", {
      name: "#Frontpage description — show in full",
    });
    expect(topic).toHaveAttribute("aria-expanded", "false");

    await user.click(topic);
    expect(topic).toHaveAttribute("aria-expanded", "true");
    const popover = screen.getByRole("dialog", {
      name: "#Frontpage description",
    });
    expect(popover).toHaveTextContent("Warm glass and growing things.");
  });
});

// The row measures itself and folds its lowest-priority controls into the ⋯
// overflow (#375). The arithmetic is header-toolbar.test.ts's subject; what
// these cases are for is that the row wires the measurement up, renders the
// fold, and loses nothing on the way into the menu.
describe("conversation toolbar collapse", () => {
  const OVERFLOW = "More conversation actions";

  function renderDm() {
    cacheProfile("Europe/Berlin", null); // gives the partner a clock
    return render(
      <MemoryRouter>
        <DmHeader identityId="id1" dm={dm()} />
      </MemoryRouter>,
    );
  }

  it("keeps every control inline while the row is roomy", () => {
    setWindowWidth(900); // compact — the tier where the measurement decides
    renderDm();
    measureRow(600);

    expect(screen.getByRole("button", { name: "Pin" })).toBeInTheDocument();
    expect(screen.getByTitle(/local time/)).toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: "Wren Salloway — status — show in full",
      }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: OVERFLOW })).toBeNull();
  });

  it("folds the topic and the clock first, and only those", () => {
    setWindowWidth(900);
    renderDm();
    measureRow(500);

    expect(screen.queryByTitle(/local time/)).toBeNull();
    expect(
      screen.queryByRole("button", {
        name: "Wren Salloway — status — show in full",
      }),
    ).toBeNull();
    // Every chip is still on the row.
    for (const name of ["Pin", "Mute conversation", "Ignore"]) {
      expect(screen.getByRole("button", { name })).toBeInTheDocument();
    }
    expect(screen.getByRole("button", { name: OVERFLOW })).toBeInTheDocument();
  });

  it("keeps a folded control reachable, labelled and titled", async () => {
    const user = userEvent.setup();
    setWindowWidth(900);
    renderDm();
    measureRow(400);

    expect(screen.queryByRole("button", { name: "Pin" })).toBeNull();
    await user.click(screen.getByRole("button", { name: OVERFLOW }));

    const menu = screen.getByRole("dialog", { name: OVERFLOW });
    const pin = screen.getByRole("button", { name: "Pin" });
    expect(menu).toContainElement(pin);
    // The chip moved, it did not become a second implementation: same
    // aria-label, same title, same toggle state, and its own text label.
    expect(pin).toHaveAttribute("title", "Pin — rejoin on connect");
    expect(pin).toHaveAttribute("aria-pressed", "false");
    expect(pin).toHaveTextContent("Pin");
  });

  it("reads the folded clock out in full, with whose clock it is", async () => {
    const user = userEvent.setup();
    setWindowWidth(900);
    renderDm();
    measureRow(400);

    await user.click(screen.getByRole("button", { name: OVERFLOW }));
    expect(screen.getByTitle(/local time/)).toHaveTextContent(
      /Wren Salloway's local time/,
    );
  });

  it("keeps exactly the inbox and search on a phone, search right-most", () => {
    setWindowWidth(400);
    const { container } = renderDm();
    measureRow(400);

    // Spec §3: two chips survive, whatever the arithmetic would allow.
    for (const name of [
      "Pin",
      "Mute conversation",
      "Ignore",
      "Toggle profile panel",
      "Actions for Wren Salloway",
      "Close conversation with Wren Salloway",
    ]) {
      expect(screen.queryByRole("button", { name })).toBeNull();
    }
    expect(screen.getByRole("button", { name: OVERFLOW })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Notifications/ }),
    ).toBeInTheDocument();

    const search = screen.getByRole("textbox", { name: "Search log" });
    const row = container.querySelector("header");
    expect(row?.lastElementChild).toContainElement(search);
  });

  it("never folds on the wide tier, whatever the row measures", () => {
    setWindowWidth(1200);
    renderDm();
    measureRow(200); // absurd, and deliberately ignored

    for (const name of ["Pin", "Mute conversation", "Ignore"]) {
      expect(screen.getByRole("button", { name })).toBeInTheDocument();
    }
    expect(screen.getByTitle(/local time/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: OVERFLOW })).toBeNull();
  });

  it("hands a folded channel description to the menu, live", async () => {
    const user = userEvent.setup();
    setWindowWidth(400);
    render(
      <MemoryRouter>
        <ChannelHeader
          identityId="id1"
          channel={channelTitled("Frontpage", "Warm glass and growing things.")}
        />
      </MemoryRouter>,
    );
    measureRow(400);

    expect(
      screen.queryByRole("button", {
        name: "#Frontpage description — show in full",
      }),
    ).toBeNull();
    await user.click(screen.getByRole("button", { name: OVERFLOW }));
    expect(screen.getByRole("dialog", { name: OVERFLOW })).toHaveTextContent(
      "Warm glass and growing things.",
    );
  });
});

// The member-list toggle is the one control whose job changes with the tier
// (#375 package D). On compact and wide it flips the docked column's persisted
// preference; on the phone stack — where there is no column to dock into — it
// opens the full-height overlay, whose open state is transient and starts
// closed. Package B removed the chip from that tier entirely while the overlay
// did not exist yet; this is it doing something again.
describe("member-list toggle across the tiers", () => {
  const OVERFLOW = "More conversation actions";
  const TOGGLE = "Toggle member list";

  function busyRoom(): ChannelView {
    return {
      ...channelTitled("Frontpage"),
      members: [
        {
          character: "Rowan Ash",
          gender: "Female",
          status: "online",
          statusmsg: "",
        },
        {
          character: "Dell Marsh",
          gender: "Male",
          status: "online",
          statusmsg: "",
        },
      ],
    };
  }

  function renderRoom() {
    return render(
      <MemoryRouter>
        <ChannelHeader identityId="id1" channel={busyRoom()} />
      </MemoryRouter>,
    );
  }

  /** The ⋯ menu, which is where the toggle lives on a phone (spec §3). */
  async function openMenu(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getByRole("button", { name: OVERFLOW }));
    return screen.getByRole("dialog", { name: OVERFLOW });
  }

  it("keeps the toggle on a phone, in the ⋯ menu, count and all", async () => {
    const user = userEvent.setup();
    setWindowWidth(390);
    renderRoom();
    measureRow(390);

    // Not on the row — the phone keeps two chips, and this is not one of them.
    expect(screen.queryByRole("button", { name: TOGGLE })).toBeNull();

    const chip = within(await openMenu(user)).getByRole("button", {
      name: TOGGLE,
    });
    expect(chip).toHaveTextContent("Member list");
    expect(chip).toHaveTextContent("2");
    expect(chip).toHaveAttribute("aria-pressed", "false");
  });

  it("drives the overlay on a phone, never the docked preference", async () => {
    const user = userEvent.setup();
    setWindowWidth(390);
    renderRoom();
    measureRow(390);

    await user.click(
      within(await openMenu(user)).getByRole("button", { name: TOGGLE }),
    );
    expect(useUiStore.getState().membersDrawerOpen).toBe(true);
    // The persisted column preference is untouched: it is open by default, and
    // it is what would otherwise have put a member list over every
    // conversation a phone opens.
    expect(useUiStore.getState().membersOpen).toBe(true);

    // Reopening the menu, the chip reads the overlay's real state.
    expect(
      within(await openMenu(user)).getByRole("button", { name: TOGGLE }),
    ).toHaveAttribute("aria-pressed", "true");
  });

  it("drives the docked column on the desktop grid, as it always has", async () => {
    const user = userEvent.setup();
    setWindowWidth(1200);
    renderRoom();

    const chip = screen.getByRole("button", { name: TOGGLE });
    expect(chip).toHaveAttribute("aria-pressed", "true");
    await user.click(chip);
    expect(useUiStore.getState().membersOpen).toBe(false);
    expect(useUiStore.getState().membersDrawerOpen).toBe(false);
    expect(chip).toHaveAttribute("aria-pressed", "false");
  });
});

// ── the connection chip on the phone stack (#377, MP3 §5) ────────────────────
//
// The sidebar has said "Offline, tap to retry" since #465, and the phone stack
// hides the sidebar whenever a conversation is open. Installed to a home
// screen there is no address bar behind it either, so without this the one
// recovery the app has is on the one screen the user is not looking at.

describe("conversation toolbar connection chip", () => {
  const initialGateway = useUiStore.getState().gatewayStatus;
  afterEach(() => {
    useUiStore.setState({ gatewayStatus: initialGateway });
  });

  /** `backTo` is what AppShell passes only while the shell is stacked, so it
   * is also the exact condition the chip rides on. */
  function renderStacked() {
    return render(
      <MemoryRouter>
        <ChannelHeader
          identityId="id1"
          channel={channelTitled("Frontpage")}
          backTo="/app/@me"
        />
      </MemoryRouter>,
    );
  }

  it("says so on the conversation pane, and retries on tap", async () => {
    const user = userEvent.setup();
    useUiStore.setState({ gatewayStatus: "offline" });
    const reconnect = vi
      .spyOn(gateway, "reconnectNow")
      .mockImplementation(() => undefined);
    renderStacked();

    const chip = screen.getByRole("button", { name: "Reconnect now" });
    expect(chip).toHaveTextContent("Offline");
    await user.click(chip);
    expect(reconnect).toHaveBeenCalledTimes(1);
    reconnect.mockRestore();
  });

  it("reads the mid-retry state rather than claiming offline", () => {
    useUiStore.setState({ gatewayStatus: "connecting" });
    renderStacked();
    expect(
      screen.getByRole("button", { name: "Reconnect now" }),
    ).toHaveTextContent("Connecting…");
  });

  it("is absent while connected, and on every tier with a sidebar", () => {
    useUiStore.setState({ gatewayStatus: "online" });
    const { unmount } = renderStacked();
    expect(screen.queryByRole("button", { name: "Reconnect now" })).toBeNull();
    unmount();

    // Not stacked: the sidebar is on screen with the chip already on it, and a
    // second copy in the toolbar would be one state said twice.
    useUiStore.setState({ gatewayStatus: "offline" });
    render(
      <MemoryRouter>
        <ChannelHeader identityId="id1" channel={channelTitled("Frontpage")} />
      </MemoryRouter>,
    );
    expect(screen.queryByRole("button", { name: "Reconnect now" })).toBeNull();
  });

  it("rides the DM toolbar too", () => {
    useUiStore.setState({ gatewayStatus: "offline" });
    render(
      <MemoryRouter>
        <DmHeader identityId="id1" dm={dm()} backTo="/app/@me" />
      </MemoryRouter>,
    );
    expect(
      screen.getByRole("button", { name: "Reconnect now" }),
    ).toHaveTextContent("Offline");
  });
});
