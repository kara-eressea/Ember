// @vitest-environment jsdom
//
// #350: the channel header renders the room title as plain text (an <h1>,
// never through RichText), so a server-escaped title must be decoded or it
// shows raw "&amp;". The viewer here is a non-op, so the op-only RoomChip
// (which pulls in gateway/store machinery) never mounts.

import { afterEach, describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
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

function channelTitled(title: string): ChannelView {
  return {
    convId: "c1",
    key: "Frontpage",
    title,
    description: "",
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
    expect(screen.getByText(/Local time/).getAttribute("title")).toContain(
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
    expect(screen.getByText(/Local time/).getAttribute("title")).toContain(
      "UTC+2",
    );
    unmount();

    cacheProfile(null, null);
    render(
      <MemoryRouter>
        <DmHeader identityId="id1" dm={dm()} />
      </MemoryRouter>,
    );
    expect(screen.queryByText(/Local time/)).toBeNull();
  });
});
