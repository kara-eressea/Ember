// @vitest-environment jsdom
//
// The "Invite to →" submenu opens on hover AND on click. Because the pointer
// necessarily enters the wrapper before the click lands, a click that toggled
// would shut the panel hover had just opened — the #316 E2E flake.

import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { MemberContextMenu } from "./MemberContextMenu.js";
import { useSessionsStore, type ChannelView } from "../../stores/sessions.js";
import type { MemberDto } from "@emberchat/protocol";

vi.mock("../../lib/social.js", () => ({
  loadSocial: vi.fn(() => Promise.resolve()),
}));

const initialSessions = useSessionsStore.getState().sessions;
afterEach(() => {
  useSessionsStore.setState({ sessions: initialSessions });
});

const HARBOR: ChannelView = {
  convId: "c1",
  key: "ADH-inviteharbor",
  title: "Invite Harbor",
  description: "",
  mode: "both",
  oplist: ["Briar Vale"],
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

const NETTLE: MemberDto = {
  character: "Nettle Fen",
  gender: "Female",
  status: "online",
  statusmsg: "",
};

function renderMenu() {
  useSessionsStore.setState({
    sessions: {
      id1: {
        ...useSessionsStore.getState().sessions["id1"],
        channels: { [HARBOR.key]: HARBOR },
      },
    } as never,
  });
  render(
    <MemoryRouter>
      <MemberContextMenu
        identityId="id1"
        ownCharacter="Briar Vale"
        channelTitle="Gardening"
        member={NETTLE}
        position={{ x: 0, y: 0 }}
        onClose={vi.fn()}
      />
    </MemoryRouter>,
  );
  return screen.getByRole("menuitem", { name: /^Invite to/ });
}

describe('MemberContextMenu "Invite to →" (#316)', () => {
  it("keeps the submenu open when the pointer hovers and then clicks", async () => {
    const user = userEvent.setup();
    const parent = renderMenu();

    await user.hover(parent);
    await user.click(parent);

    expect(
      screen.getByRole("menu", { name: "Invite Nettle Fen to a channel" }),
    ).toBeInTheDocument();
    // Listed by title, never by the opaque ADH- key (#311).
    expect(
      screen.getByRole("menuitem", { name: "Invite Harbor" }),
    ).toBeInTheDocument();
    expect(parent).toHaveAttribute("aria-expanded", "true");
  });

  it("closes again once the pointer leaves the submenu wrapper", async () => {
    const user = userEvent.setup();
    const parent = renderMenu();

    await user.click(parent);
    await user.unhover(parent);

    expect(parent).toHaveAttribute("aria-expanded", "false");
    expect(
      screen.queryByRole("menu", { name: "Invite Nettle Fen to a channel" }),
    ).not.toBeInTheDocument();
  });
});
