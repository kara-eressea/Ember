// @vitest-environment jsdom
//
// The picker's Favorites tab is the composing-side surface for the favourite
// list the log's right-click menu writes to: it opens selected, so a
// favourited eicon is one click away. Blocked eicons never render their image
// here either — browsing is not a reason to show one back.

import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PREFS_DEFAULTS, type UserPrefs } from "@emberchat/protocol";
import { EiconPicker } from "./EiconPicker.js";
import { EiconContextMenu } from "./EiconContextMenu.js";
import { useEiconMenuStore } from "../../stores/eicon-menu.js";
import {
  useSessionsStore,
  type IdentitySession,
} from "../../stores/sessions.js";
import { useUiStore } from "../../stores/ui.js";

vi.mock("../../gateway/socket.js", () => ({
  gateway: { cmd: vi.fn().mockResolvedValue({ ok: true }) },
}));

// The picker re-places itself on a content-driven resize (#472); jsdom has no
// ResizeObserver. A no-op stub is enough — placement is asserted separately in
// EiconPicker.placement.test.tsx, which drives the observer for real.
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
globalThis.ResizeObserver ??=
  ResizeObserverStub as unknown as typeof ResizeObserver;

const IDENTITY = "id1";
const ANCHOR = { top: 300, left: 100, bottom: 320, right: 140 };

/** The menu reads prefs from the store, the picker from its prop — seed both
 * so the two agree, as they do in the app. */
function renderPicker(patch: Partial<UserPrefs> = {}) {
  const prefs = { ...PREFS_DEFAULTS, ...patch };
  useSessionsStore.setState({
    sessions: {
      [IDENTITY]: {
        identityId: IDENTITY,
        prefs,
        synced: true,
        channels: {},
        dms: {},
      } as unknown as IdentitySession,
    },
  });
  useUiStore.setState({ activeIdentityId: IDENTITY });
  return render(
    <>
      <EiconPicker
        identityId={IDENTITY}
        prefs={prefs}
        anchor={ANCHOR}
        iconsBlacklisted={false}
        onInsert={vi.fn()}
        onClose={vi.fn()}
      />
      <EiconContextMenu />
    </>,
  );
}

const initialSessions = useSessionsStore.getState().sessions;
afterEach(() => {
  useSessionsStore.setState({ sessions: initialSessions });
  useUiStore.setState({ activeIdentityId: undefined });
  useEiconMenuStore.getState().close();
  vi.clearAllMocks();
});

describe("EiconPicker favourites", () => {
  it("opens on Favorites and lists them as insertable tiles", () => {
    const { container } = renderPicker({ eiconFavorites: ["sparkle", "grin"] });

    expect(screen.getByRole("tab", { name: "Favorites" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(
      screen.getByRole("button", { name: "Insert sparkle" }),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Insert grin" })).toBeVisible();
    expect(container.querySelectorAll("img")).toHaveLength(2);
    // Each tile carries the star that toggles it back off.
    expect(
      screen.getByRole("button", { name: "Remove sparkle from favorites" }),
    ).toBeVisible();
  });

  it("shows the empty state with no favourites", () => {
    renderPicker();
    expect(screen.getByText("No favorites yet")).toBeVisible();
  });

  it("renders a blocked eicon as its bare name, never its image", () => {
    const { container } = renderPicker({
      eiconFavorites: ["sparkle", "grin"],
      eiconBlocked: ["Sparkle"],
    });

    // Only the unblocked one keeps an image; the blocked tile is still
    // insertable, just shown as text.
    expect(container.querySelectorAll("img")).toHaveLength(1);
    expect(
      within(screen.getByRole("button", { name: "Insert sparkle" })).getByText(
        "sparkle",
      ),
    ).toBeVisible();
  });
});

describe("EiconPicker right-click", () => {
  it("opens the favourite/block menu on a tile", async () => {
    const user = userEvent.setup();
    renderPicker({ eiconFavorites: ["sparkle"] });

    await user.pointer({
      keys: "[MouseRight]",
      target: screen.getByRole("button", { name: "Insert sparkle" }),
    });
    const menu = await screen.findByRole("menu");
    expect(menu).toHaveAccessibleName("sparkle eicon menu");
    expect(within(menu).getByRole("menuitem", { name: "Block" })).toBeVisible();
    // Already a favourite, so the menu offers to take it back off.
    expect(
      within(menu).getByRole("menuitem", { name: "Unfavourite" }),
    ).toBeVisible();
  });
});
