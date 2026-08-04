// @vitest-environment jsdom
//
// #350: the channel member list renders a member's status on a second line
// outside RichText — its own restricted subset since #494 — so it must decode
// the server's wire entities itself or it shows raw "&amp;". This is the exact
// surface from the live v0.14.0 screenshot.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemberList } from "./MemberList.js";
import { useSessionsStore, type ChannelView } from "../../stores/sessions.js";
import { presenceDot } from "../../lib/presence.js";
import type { MemberDto } from "@emberchat/protocol";

// The member-list mount lazily loads friends/bookmarks; stub it so no relative
// fetch escapes into jsdom (the sort tiers are irrelevant to this test).
vi.mock("../../lib/social.js", () => ({ loadSocial: vi.fn() }));

// presenceDot runs once per member-row render — a clean render-count probe for
// the #355 memoization work.
vi.mock("../../lib/presence.js", () => ({ presenceDot: vi.fn(() => "ok") }));

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

describe("MemberList Find field (#497)", () => {
  const members: MemberDto[] = [
    {
      character: "Vesna Kohl",
      gender: "Female",
      status: "online",
      statusmsg: "",
    },
    {
      character: "Dell Marsh",
      gender: "Male",
      status: "looking",
      statusmsg: "open for [b]dragon[/b] RP",
    },
  ];

  /** Type `query` into the Find field and read back the surviving rows. */
  async function filterBy(query: string): Promise<string> {
    const field = screen.getByLabelText("Find members");
    await userEvent.clear(field);
    await userEvent.type(field, query);
    return screen
      .queryAllByRole("listitem")
      .map((row) => row.textContent ?? "")
      .join("|");
  }

  beforeEach(() => {
    render(
      <MemberList
        identityId="id1"
        ownCharacter="Moss Tinker"
        channel={channelWith(members)}
      />,
    );
  });

  it("filters by gender, not only by nick", async () => {
    const rows = await filterBy("female");
    expect(rows).toContain("Vesna Kohl");
    expect(rows).not.toContain("Dell Marsh");
  });

  // The male/female substring trap, at the surface the user sees it.
  it("does not return the female character for a 'male' query", async () => {
    const rows = await filterBy("male");
    expect(rows).toContain("Dell Marsh");
    expect(rows).not.toContain("Vesna Kohl");
  });

  it("filters by status and by what the status line says", async () => {
    expect(await filterBy("looking")).toContain("Dell Marsh");
    expect(await filterBy("dragon")).toContain("Dell Marsh");
    expect(await filterBy("dragon")).not.toContain("Vesna Kohl");
  });
});

describe("MemberList memoization (#355)", () => {
  it("does not re-render member rows when the channel reference is unchanged", () => {
    const members: MemberDto[] = [
      {
        character: "Amber Vale",
        gender: "Female",
        status: "online",
        statusmsg: "",
      },
      {
        character: "Nyx Firemane",
        gender: "Female",
        status: "online",
        statusmsg: "",
      },
    ];
    const channel = channelWith(members);
    const element = (
      <MemberList
        identityId="id1"
        ownCharacter="Moss Tinker"
        channel={channel}
      />
    );
    const { rerender } = render(element);
    const afterMount = vi.mocked(presenceDot).mock.calls.length;
    expect(afterMount).toBeGreaterThanOrEqual(members.length);

    // A parent re-render with the identical channel object (the common case
    // once presence updates preserve identity) must not re-run any row.
    rerender(element);
    expect(vi.mocked(presenceDot).mock.calls.length).toBe(afterMount);
  });
});
