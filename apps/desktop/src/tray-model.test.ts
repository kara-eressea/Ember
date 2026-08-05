import { describe, expect, it } from "vitest";
import { trayIconPath } from "./paths.js";
import {
  decideLastWindowClosed,
  decideWindowClose,
  trayMenuModel,
  trayNoticeMessage,
  trayStatusLine,
  trayTooltip,
  type CloseContext,
  type LifecycleMode,
  type ShellWindow,
} from "./tray-model.js";

const PRODUCT = "EmberChat";

function context(overrides: Partial<CloseContext> = {}): CloseContext {
  return { mode: "local", trayPresent: true, quitting: false, ...overrides };
}

describe("what a closing window means", () => {
  // The whole of §6 in one table: only the app window, only in local mode,
  // only while a tray exists to bring it back, and only when nobody has asked
  // the app to quit.
  const cases: ReadonlyArray<
    readonly [ShellWindow, LifecycleMode, boolean, boolean, string]
  > = [
    // window, mode, trayPresent, quitting, verdict
    ["app", "local", true, false, "hide-to-tray"],
    ["app", "local", false, false, "close"],
    ["app", "local", true, true, "close"],
    ["app", "thin-client", false, false, "close"],
    // A tray in thin-client mode is not a thing this shell builds; if one ever
    // existed it would still not keep a window that has no bouncer behind it.
    ["app", "thin-client", true, false, "close"],
    ["app", "choose", false, false, "close"],
    ["chooser", "local", true, false, "close"],
    ["chooser", "choose", false, false, "close"],
    ["error", "thin-client", false, false, "close"],
    ["error", "local", true, false, "close"],
  ];

  it.each(cases)(
    "%s window, %s mode, tray=%s, quitting=%s → %s",
    (window, mode, trayPresent, quitting, verdict) => {
      expect(decideWindowClose(window, { mode, trayPresent, quitting })).toBe(
        verdict,
      );
    },
  );

  it("hides the app window rather than stopping the bouncer", () => {
    // Invariant 6, stated as a test: closing a window is never a way to stop
    // the server child, because the window does not close at all.
    expect(decideWindowClose("app", context())).toBe("hide-to-tray");
  });

  it("closes everything once a quit is under way", () => {
    // Including the mode switch's relaunch, which never reaches `before-quit`
    // — `main.ts` folds `stopping` into the same flag.
    expect(decideWindowClose("app", context({ quitting: true }))).toBe("close");
  });
});

describe("what no windows left means", () => {
  it("is a normal state in local mode with a tray", () => {
    expect(decideLastWindowClosed(context())).toBe("stay");
  });

  it.each([
    ["there is no tray to get back in with", context({ trayPresent: false })],
    [
      "this is thin-client mode",
      context({ mode: "thin-client", trayPresent: false }),
    ],
    [
      "the chooser was declined",
      context({ mode: "choose", trayPresent: false }),
    ],
    ["a quit is already under way", context({ quitting: true })],
  ])("quits when %s", (_label, input) => {
    expect(decideLastWindowClosed(input)).toBe("quit");
  });
});

describe("the tray menu", () => {
  it("says what this is, how it is doing, and offers exactly two things", () => {
    const model = trayMenuModel({ productName: PRODUCT, status: "running" });
    expect(model.items.filter((item) => item.kind === "info")).toEqual([
      { kind: "info", label: PRODUCT },
      { kind: "info", label: trayStatusLine("running") },
    ]);
    expect(
      model.items
        .filter((item) => item.kind === "command")
        .map((item) => [item.id, item.label]),
    ).toEqual([
      ["open", `Open ${PRODUCT}`],
      ["quit", `Quit ${PRODUCT}`],
    ]);
  });

  it("takes the product name from its caller, never a literal", () => {
    // The product name is config (CLAUDE.md) — a rename must not need a grep
    // through the tray.
    const model = trayMenuModel({
      productName: "Something Else",
      status: "running",
    });
    for (const item of model.items) {
      if (item.kind !== "separator") {
        expect(item.label).not.toContain(PRODUCT);
      }
    }
  });

  it("distinguishes a bouncer that is still starting from one that is up", () => {
    const starting = trayMenuModel({
      productName: PRODUCT,
      status: "connecting",
    });
    const running = trayMenuModel({ productName: PRODUCT, status: "running" });
    expect(starting.items).not.toEqual(running.items);
    expect(trayStatusLine("connecting")).toBe("Starting up…");
    expect(trayStatusLine("running")).toContain("online");
    expect(trayTooltip(PRODUCT, "connecting")).toBe(`${PRODUCT} — starting up`);
    expect(trayTooltip(PRODUCT, "running")).toBe(`${PRODUCT} — running`);
  });
});

describe("the one-time notice", () => {
  it("says the deal: still running, sessions online, quit to go offline", () => {
    const notice = trayNoticeMessage(PRODUCT);
    expect(notice.title.toLowerCase()).toContain("tray");
    expect(notice.body).toContain(PRODUCT);
    expect(notice.body.toLowerCase()).toContain("online");
    // The half that makes it an honest deal rather than an advertisement.
    expect(notice.body.toLowerCase()).toContain("quit");
  });
});

describe("the tray icon", () => {
  it("is a template image on macOS and the app's own artwork elsewhere", () => {
    expect(trayIconPath("/app", "darwin")).toBe("/app/assets/trayTemplate.png");
    expect(trayIconPath("/app", "win32")).toBe("/app/assets/tray.png");
    expect(trayIconPath("/app", "linux")).toBe("/app/assets/tray.png");
  });
});
