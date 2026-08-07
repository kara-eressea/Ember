import { describe, expect, it } from "vitest";
import { withUpdateCheck, type DesktopConfig } from "./desktop-config.js";
import {
  updateCheckEnabled,
  updateCheckNotice,
  UPDATE_CHECK_MENU_LABEL,
} from "./update-check.js";

const LOCAL: DesktopConfig = { mode: "local" };

describe("updateCheckEnabled", () => {
  it("is on by default — including for a config that could not be read", () => {
    // The server's own default is `true`, and an install that has never seen
    // this setting must behave exactly as it did before the setting existed.
    expect(updateCheckEnabled(LOCAL)).toBe(true);
    expect(updateCheckEnabled(undefined)).toBe(true);
    expect(updateCheckEnabled({ mode: "local", trayNoticeSeen: true })).toBe(
      true,
    );
  });

  it("is off once the user has said so, and on again when they undo it", () => {
    const off = withUpdateCheck(LOCAL, false);
    expect(updateCheckEnabled(off)).toBe(false);
    expect(updateCheckEnabled(withUpdateCheck(off, true))).toBe(true);
  });
});

describe("the words a user reads", () => {
  it("say what the setting does, without naming a mechanism", () => {
    // #543's discipline: no "bouncer", no "phone home", no "release check API".
    const jargon = /bouncer|embedded server|phone|endpoint|API|GitHub API/i;
    expect(UPDATE_CHECK_MENU_LABEL).toBe("Check for updates automatically");
    for (const enabled of [true, false]) {
      const { title, body } = updateCheckNotice("EmberChat", enabled);
      expect(title).not.toMatch(jargon);
      expect(body).not.toMatch(jargon);
      expect(body).toContain("EmberChat");
    }
  });

  it("names the delay, because the setting only lands on the next start", () => {
    // The one thing that must be said: a user who turns this off and then sees
    // a check happen would otherwise conclude the checkbox is decorative.
    expect(updateCheckNotice("EmberChat", false).body).toContain(
      "the next time you open EmberChat",
    );
    expect(updateCheckNotice("EmberChat", true).body).toContain(
      "the next time you open EmberChat",
    );
  });
});
