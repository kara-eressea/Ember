// @vitest-environment jsdom
//
// #350: the channel header renders the room title as plain text (an <h1>,
// never through RichText), so a server-escaped title must be decoded or it
// shows raw "&amp;". The viewer here is a non-op, so the op-only RoomChip
// (which pulls in gateway/store machinery) never mounts.

import { afterEach, describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { ChannelHeader } from "./ChannelHeader.js";
import { useSessionsStore, type ChannelView } from "../../stores/sessions.js";

const initialSessions = useSessionsStore.getState().sessions;
afterEach(() => {
  useSessionsStore.setState({ sessions: initialSessions });
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
