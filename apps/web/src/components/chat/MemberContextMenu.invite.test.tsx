// @vitest-environment jsdom
//
// The "Invite to →" submenu opens on hover AND on click. Because the pointer
// necessarily enters the wrapper before the click lands, a click that toggled
// would shut the panel hover had just opened — the #316 E2E flake.
//
// …and the other half, from MP2's package-D audit (closed in MP4, #378): on a
// touchscreen that arrangement has no close path at all. The engines fire a
// compatibility `mouseenter` from the press that raises the action sheet, so
// the sheet arrived with the panel already expanded, and they never send the
// `mouseleave` an open-only trigger is relying on. Where `hover: none` matches,
// the hover pair is not attached and the click is a toggle
// (lib/useSubmenuTrigger.ts).

import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { MemberContextMenu } from "./MemberContextMenu.js";
import { useSessionsStore, type ChannelView } from "../../stores/sessions.js";
import type { MemberDto } from "@emberchat/protocol";
import { stubNoHover } from "../../test-support/dom.js";

vi.mock("../../lib/social.js", () => ({
  loadSocial: vi.fn(() => Promise.resolve()),
}));

const initialSessions = useSessionsStore.getState().sessions;
afterEach(() => {
  useSessionsStore.setState({ sessions: initialSessions });
  vi.unstubAllGlobals();
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

describe('MemberContextMenu "Invite to →" on a touchscreen (#378)', () => {
  it("does not open from the compatibility mouseenter a press synthesizes", async () => {
    stubNoHover();
    const user = userEvent.setup();
    const parent = renderMenu();

    // The press that raised the sheet, arriving as a mouse would: this is the
    // event that used to expand the panel before the user had touched it.
    await user.hover(parent);

    expect(parent).toHaveAttribute("aria-expanded", "false");
    expect(
      screen.queryByRole("menu", { name: "Invite Nettle Fen to a channel" }),
    ).not.toBeInTheDocument();
  });

  it("opens and closes again from taps, with no mouseleave to rely on", async () => {
    stubNoHover();
    const user = userEvent.setup();
    const parent = renderMenu();

    await user.click(parent);
    expect(parent).toHaveAttribute("aria-expanded", "true");
    expect(
      screen.getByRole("menuitem", { name: "Invite Harbor" }),
    ).toBeInTheDocument();

    // The gesture that did not exist before: a second tap on the trigger. A
    // touchscreen sends no `mouseleave`, so under the open-only trigger the
    // only way back was Escape, which a phone does not have.
    await user.click(parent);
    expect(parent).toHaveAttribute("aria-expanded", "false");
    expect(
      screen.queryByRole("menu", { name: "Invite Nettle Fen to a channel" }),
    ).not.toBeInTheDocument();
  });
});
