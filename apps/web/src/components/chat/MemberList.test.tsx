// @vitest-environment jsdom
//
// #350: the channel member list renders a member's status on a second line as
// PLAIN text (BBCode stripped, one-line/dense — never through RichText), so it
// must decode the server's wire entities itself or it shows raw "&amp;". This
// is the exact surface from the live v0.14.0 screenshot.

import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemberList } from "./MemberList.js";
import { useSessionsStore, type ChannelView } from "../../stores/sessions.js";
import type { MemberDto } from "@emberchat/protocol";

// The member-list mount lazily loads friends/bookmarks; stub it so no relative
// fetch escapes into jsdom (the sort tiers are irrelevant to this test).
vi.mock("../../lib/social.js", () => ({ loadSocial: vi.fn() }));

const initialSessions = useSessionsStore.getState().sessions;
afterEach(() => {
  useSessionsStore.setState({ sessions: initialSessions });
});

function channelWith(members: MemberDto[]): ChannelView {
  return {
    convId: "c1",
    key: "Frontpage",
    title: "Frontpage",
    description: "",
    mode: "both",
    oplist: [""],
    members,
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

describe("MemberList status entity decode (#350)", () => {
  it("renders a server-escaped status line decoded, not as raw &amp;", () => {
    const member: MemberDto = {
      character: "Ivy Bramblewood",
      gender: "Female",
      // The live wire form: the server double-escaped a literal "&".
      statusmsg: "Other canons &amp; Summer Vibes!",
      status: "online",
    };
    render(
      <MemberList
        identityId="id1"
        ownCharacter="Moss Tinker"
        channel={channelWith([member])}
      />,
    );
    expect(
      screen.getByText("Other canons & Summer Vibes!"),
    ).toBeInTheDocument();
    expect(screen.queryByText(/&amp;/)).not.toBeInTheDocument();
  });
});
