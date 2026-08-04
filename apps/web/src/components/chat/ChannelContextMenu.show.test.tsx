// @vitest-environment jsdom
//
// The channel menu's "Show →" submenu, on both kinds of pointer (#378).
//
// It is a copy of MemberContextMenu's "Invite to →" — including, until MP4,
// the half of it that only works with a mouse. MP2's package-D audit caught
// the pattern on the member menu and filed it; the sweep for the fix found the
// second copy here, which nothing had looked at because the finding named one
// surface and this is the other. Both now go through lib/useSubmenuTrigger.ts,
// which is the point of naming it once.
//
// The extra thing this menu has and the member menu does not: the trigger is
// present but disabled in rooms the server locks to one message kind, and it
// must stay shut by either route there.

import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { ChannelContextMenu } from "./ChannelContextMenu.js";
import { useSessionsStore, type ChannelView } from "../../stores/sessions.js";

vi.mock("../../gateway/socket.js", () => ({
  gateway: { cmd: vi.fn().mockResolvedValue({ ok: true }) },
}));

const initialSessions = useSessionsStore.getState().sessions;
afterEach(() => {
  useSessionsStore.setState({ sessions: initialSessions });
  vi.unstubAllGlobals();
});

/** jsdom ships no matchMedia, which is already the "has a hover" answer
 * (useNoHover defaults to false). This installs one that says otherwise —
 * the same stub RichText.touch.test.tsx uses. */
function stubNoHover(): void {
  vi.stubGlobal(
    "matchMedia",
    (query: string): MediaQueryList =>
      ({
        matches: query === "(hover: none)",
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }) as unknown as MediaQueryList,
  );
}

const LANTERN: ChannelView = {
  convId: "c1",
  key: "ADH-showlantern",
  title: "Show Lantern",
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

function renderMenu(channel: ChannelView = LANTERN) {
  useSessionsStore.setState({
    sessions: {
      id1: {
        ...useSessionsStore.getState().sessions["id1"],
        channels: { [channel.key]: channel },
      },
    } as never,
  });
  render(
    <MemoryRouter>
      <ChannelContextMenu
        identityId="id1"
        ownCharacter="Briar Vale"
        channel={channel}
        active={false}
        position={{ x: 0, y: 0 }}
        onClose={vi.fn()}
      />
    </MemoryRouter>,
  );
  return screen.getByRole("menuitem", { name: /^Show/ });
}

describe('ChannelContextMenu "Show →" under a mouse (#237)', () => {
  it("stays open when the pointer hovers and then clicks", async () => {
    const user = userEvent.setup();
    const parent = renderMenu();

    await user.hover(parent);
    await user.click(parent);

    expect(parent).toHaveAttribute("aria-expanded", "true");
    expect(
      screen.getByRole("menu", { name: "Show chat, ads, or both" }),
    ).toBeInTheDocument();
  });

  it("closes again once the pointer leaves the wrapper", async () => {
    const user = userEvent.setup();
    const parent = renderMenu();

    await user.click(parent);
    await user.unhover(parent);

    expect(parent).toHaveAttribute("aria-expanded", "false");
  });
});

describe('ChannelContextMenu "Show →" on a touchscreen (#378)', () => {
  it("does not open from the compatibility mouseenter a press synthesizes", async () => {
    stubNoHover();
    const user = userEvent.setup();
    const parent = renderMenu();

    await user.hover(parent);

    expect(parent).toHaveAttribute("aria-expanded", "false");
    expect(
      screen.queryByRole("menu", { name: "Show chat, ads, or both" }),
    ).not.toBeInTheDocument();
  });

  it("opens and closes again from taps", async () => {
    stubNoHover();
    const user = userEvent.setup();
    const parent = renderMenu();

    await user.click(parent);
    expect(parent).toHaveAttribute("aria-expanded", "true");

    await user.click(parent);
    expect(parent).toHaveAttribute("aria-expanded", "false");
  });

  it("stays shut in a room with only one kind of message to show", async () => {
    stubNoHover();
    const user = userEvent.setup();
    const parent = renderMenu({ ...LANTERN, mode: "chat" });

    // The item renders disabled rather than hidden (#237) — the choice exists
    // and has nothing to do. A toggle that ignored that would open an empty
    // panel on the one pointer that cannot see the disabled styling coming.
    expect(parent).toBeDisabled();
    await user.click(parent);
    expect(parent).toHaveAttribute("aria-expanded", "false");
  });
});
