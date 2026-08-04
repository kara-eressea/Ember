// @vitest-environment jsdom
//
// The message-font control (Appearance → Messages). Same shape as every other
// control in the pane: a synced pref written through the prefs patch. The face
// itself is a var on the log root — see MessageFontFamily.test.tsx.

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

describe("AppearancePane message font", () => {
  it("defaults to the app's sans — today's rendering, unchanged", () => {
    expect(PREFS_DEFAULTS.messageFont).toBe("sans");
    renderPane();
    expect(
      screen
        .getByRole("radiogroup", { name: "Message font" })
        .querySelector('[aria-checked="true"]')?.textContent,
    ).toBe("Sans");
  });

  it("patches the pref when another face is chosen", () => {
    renderPane();
    patchPrefs.mockClear();

    fireEvent.click(screen.getByRole("radio", { name: "Serif" }));

    expect(patchPrefs).toHaveBeenCalledWith("id-1", { messageFont: "serif" });
  });
});
