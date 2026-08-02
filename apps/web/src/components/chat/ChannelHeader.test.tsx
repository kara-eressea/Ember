// @vitest-environment jsdom
//
// #350: the channel header renders the room title as plain text (an <h1>,
// never through RichText), so a server-escaped title must be decoded or it
// shows raw "&amp;". The viewer here is a non-op, so the op-only RoomChip
// (which pulls in gateway/store machinery) never mounts.

import { afterEach, describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { ChannelHeader, DmHeader } from "./ChannelHeader.js";
import { useProfileStore } from "../../stores/profile.js";
import {
  useSessionsStore,
  type ChannelView,
  type DmView,
} from "../../stores/sessions.js";

const initialSessions = useSessionsStore.getState().sessions;
afterEach(() => {
  useSessionsStore.setState({ sessions: initialSessions });
  useProfileStore.setState({ profiles: {} });
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
