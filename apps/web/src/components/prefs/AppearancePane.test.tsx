// @vitest-environment jsdom
//
// #416: the sidebar-avatar switch lives with the other appearance prefs and
// writes through the synced prefs patch like every control in the pane.

import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { PREFS_DEFAULTS } from "@emberchat/protocol";
import { AppearancePane } from "./AppearancePane.js";
import { useSessionsStore } from "../../stores/sessions.js";

const patchPrefs = vi.hoisted(() => vi.fn(() => Promise.resolve()));
vi.mock("./patch.js", () => ({ patchPrefs }));

function renderPane() {
  useSessionsStore.setState({ sessions: {} });
  return render(<AppearancePane identityId="id-1" />);
}

describe("AppearancePane sidebar avatars", () => {
  it("defaults to on", () => {
    expect(PREFS_DEFAULTS.sidebarAvatars).toBe(true);
    renderPane();
    expect(
      screen
        .getByRole("switch", { name: "Show avatars in the sidebar" })
        .getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("patches the pref when switched off", () => {
    renderPane();
    patchPrefs.mockClear();

    fireEvent.click(
      screen.getByRole("switch", { name: "Show avatars in the sidebar" }),
    );

    expect(patchPrefs).toHaveBeenCalledWith("id-1", { sidebarAvatars: false });
  });
});
