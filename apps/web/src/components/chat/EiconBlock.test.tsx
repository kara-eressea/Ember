// @vitest-environment jsdom
//
// Favourite/block eicons from chat: right-clicking any rendered eicon opens
// the menu, blocking swaps the image for the name chip (without the hover
// preview that would defeat the block), and a block arriving from another
// device must repaint eicons that are already on screen — RichText memoizes
// the BBCode parse, so the reactivity has to come from InlineIcon's own
// prefs subscription rather than from the memo.

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PREFS_DEFAULTS, type UserPrefs } from "@emberchat/protocol";
import { RichText } from "./RichText.js";
import { EiconContextMenu } from "./EiconContextMenu.js";
import {
  useSessionsStore,
  type IdentitySession,
} from "../../stores/sessions.js";
import { useUiStore } from "../../stores/ui.js";
import { useEiconMenuStore } from "../../stores/eicon-menu.js";

const { cmdMock } = vi.hoisted(() => ({
  cmdMock: vi.fn().mockResolvedValue({ ok: true }),
}));
vi.mock("../../gateway/socket.js", () => ({ gateway: { cmd: cmdMock } }));
vi.mock("react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-router")>()),
  useNavigate: () => vi.fn(),
}));

const IDENTITY = "id1";

function seedPrefs(patch: Partial<UserPrefs> = {}): void {
  const session = {
    identityId: IDENTITY,
    character: "Me",
    sessionStatus: "online",
    ownStatus: "online",
    ownStatusmsg: "",
    ignores: [],
    limits: { chatMax: 4096, privMax: 50000, lfrpMax: 50000, lfrpFlood: 600 },
    iconBlacklist: [],
    chatop: false,
    sendDelaySeconds: 0,
    prefs: { ...PREFS_DEFAULTS, ...patch },
    outbox: [],
    campaign: null,
    channels: {},
    dms: {},
    channelByConvId: {},
    synced: true,
    invites: [],
    social: {
      bookmarks: [],
      friends: [],
      incoming: [],
      outgoing: [],
      fetchedAt: Date.now(),
    },
  } as unknown as IdentitySession;
  useSessionsStore.setState({ sessions: { [IDENTITY]: session } });
  useUiStore.setState({ activeIdentityId: IDENTITY });
}

/** The multi-device path: `prefs.updated` fans out and every attached tab
 * applies it locally. */
function fanOutPrefs(patch: Partial<UserPrefs>): void {
  const current =
    useSessionsStore.getState().sessions[IDENTITY]?.prefs ?? PREFS_DEFAULTS;
  act(() => {
    useSessionsStore.getState().applyPrefsLocal({ ...current, ...patch });
  });
}

/** The one prefs patch this interaction sent over the gateway. */
function patchedPrefs(): Partial<UserPrefs> {
  expect(cmdMock).toHaveBeenCalledTimes(1);
  const frame = cmdMock.mock.calls[0]?.[0] as {
    action: string;
    d: { prefs: Partial<UserPrefs> };
  };
  expect(frame.action).toBe("prefs.set");
  return frame.d.prefs;
}

const initialSessions = useSessionsStore.getState().sessions;
afterEach(() => {
  useSessionsStore.setState({ sessions: initialSessions });
  useUiStore.setState({ activeIdentityId: undefined });
  useEiconMenuStore.getState().close();
  vi.clearAllMocks();
});

describe("blocked eicons render as a name chip", () => {
  it("swaps the image for the name, struck through, with no hover preview", async () => {
    const user = userEvent.setup();
    seedPrefs({ eiconBlocked: ["Sparkle"] });
    const { container } = render(<RichText bbcode="[eicon]sparkle[/eicon]" />);

    // No image at all — the block is matched case-insensitively, like the
    // server's eicon index.
    expect(container.querySelector("img")).toBeNull();
    const chip = screen.getByTitle("sparkle — blocked eicon");
    expect(chip).toHaveTextContent("sparkle");

    // Hovering a *blocked* chip must not preview: a block that still shows
    // the image on hover is not a block.
    await user.hover(chip);
    expect(container.querySelector("img")).toBeNull();
  });

  it("outranks the name-only display mode's hover preview", async () => {
    const user = userEvent.setup();
    seedPrefs({ eiconDisplay: "name", eiconBlocked: ["sparkle"] });
    const { container } = render(<RichText bbcode="[eicon]sparkle[/eicon]" />);

    await user.hover(screen.getByTitle("sparkle — blocked eicon"));
    expect(container.querySelector("img")).toBeNull();
  });

  it("still previews an unblocked eicon in name-only mode", async () => {
    const user = userEvent.setup();
    seedPrefs({ eiconDisplay: "name" });
    const { container } = render(<RichText bbcode="[eicon]sparkle[/eicon]" />);

    await user.hover(screen.getByTitle("[eicon]"));
    expect(container.querySelector("img")).not.toBeNull();
  });
});

describe("a block landing from another device", () => {
  it("repaints eicons that are already on screen", () => {
    seedPrefs();
    const { container } = render(
      <RichText bbcode="hi [eicon]sparkle[/eicon]" />,
    );
    expect(container.querySelector("img")).not.toBeNull();

    fanOutPrefs({ eiconBlocked: ["sparkle"] });

    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByTitle("sparkle — blocked eicon")).toBeInTheDocument();

    // …and unblocking from the other device brings the image back.
    fanOutPrefs({ eiconBlocked: [] });
    expect(container.querySelector("img")).not.toBeNull();
  });
});

describe("the eicon right-click menu", () => {
  async function openMenu(bbcode = "[eicon]sparkle[/eicon]") {
    const user = userEvent.setup();
    render(
      <>
        <RichText bbcode={bbcode} />
        <EiconContextMenu />
      </>,
    );
    await user.pointer({
      keys: "[MouseRight]",
      target: screen.getByRole("img", { name: "sparkle" }),
    });
    return { user, menu: await screen.findByRole("menu") };
  }

  it("opens on the eicon and names it", async () => {
    seedPrefs();
    const { menu } = await openMenu();
    expect(menu).toHaveAccessibleName("sparkle eicon menu");
  });

  it("favourites the eicon", async () => {
    seedPrefs();
    const { user, menu } = await openMenu();
    await user.click(within(menu).getByRole("menuitem", { name: "Favourite" }));

    expect(patchedPrefs()).toEqual({ eiconFavorites: ["sparkle"] });
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("offers Unfavourite for one already favourited, and removes it", async () => {
    seedPrefs({ eiconFavorites: ["Sparkle"] });
    const { user, menu } = await openMenu();
    await user.click(
      within(menu).getByRole("menuitem", { name: "Unfavourite" }),
    );

    expect(patchedPrefs()).toEqual({ eiconFavorites: [] });
  });

  it("blocks the eicon, and the chip's menu unblocks it again", async () => {
    seedPrefs();
    const { user, menu } = await openMenu();
    await user.click(within(menu).getByRole("menuitem", { name: "Block" }));
    expect(patchedPrefs()).toEqual({ eiconBlocked: ["sparkle"] });

    // patchPrefs applies optimistically, so the image is already a chip —
    // right-clicking it must still reach the menu, now offering Unblock.
    cmdMock.mockClear();
    await user.pointer({
      keys: "[MouseRight]",
      target: screen.getByTitle("sparkle — blocked eicon"),
    });
    const reopened = await screen.findByRole("menu");
    await user.click(
      within(reopened).getByRole("menuitem", { name: "Unblock" }),
    );
    expect(patchedPrefs()).toEqual({ eiconBlocked: [] });
  });

  it("copies the name", async () => {
    seedPrefs();
    const { user, menu } = await openMenu();
    // Spy after userEvent.setup(), which installs its own clipboard stub.
    const writeText = vi
      .spyOn(navigator.clipboard, "writeText")
      .mockResolvedValue(undefined);
    await user.click(within(menu).getByRole("menuitem", { name: "Copy name" }));

    expect(writeText).toHaveBeenCalledWith("sparkle");
    expect(cmdMock).not.toHaveBeenCalled();
  });
});
