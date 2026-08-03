// @vitest-environment jsdom
//
// #350: the channel header renders the room title as plain text (an <h1>,
// never through RichText), so a server-escaped title must be decoded or it
// shows raw "&amp;". The viewer here is a non-op, so the op-only RoomChip
// (which pulls in gateway/store machinery) never mounts.

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { ChannelHeader, DmHeader } from "./ChannelHeader.js";
import { useProfileStore } from "../../stores/profile.js";
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

/** Put the window on a tier. The header only collapses below `wide`, and the
 * `phone` tier keeps exactly two chips whatever the measurement says. */
function setWindowWidth(width: number) {
  Object.defineProperty(window, "innerWidth", {
    value: width,
    configurable: true,
  });
}

const initialSessions = useSessionsStore.getState().sessions;
afterEach(() => {
  useSessionsStore.setState({ sessions: initialSessions });
  useProfileStore.setState({ profiles: {} });
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
