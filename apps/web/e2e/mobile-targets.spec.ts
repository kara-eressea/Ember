// 44px touch targets on the phone tier (MP2 §3, #376). Runs in the
// `mobile-chromium` project, where `hover: none` and a coarse pointer are the
// device's own answers rather than a resized desktop's.
//
// The walk is deliberately not a hand-written list of controls: a spec that
// names the eight buttons it knows about stops catching the ninth, and the
// point of this file is to be the regression guard for a rule that applies to
// every control the shell will ever grow. It opens each surface in turn and
// measures *everything* operable that is on screen (touch-targets.ts), then
// subtracts the exclusions below — each of which has to earn its line.
//
// Owns reachpalmer@example.test (Reach Palmer), pressley@example.test (Pressley Vane)
// and the Reach Room: spec files run in parallel and a character holds one sim
// connection, so specs share neither.

import {
  delay,
  expect,
  interceptAvatars,
  joinChannel,
  provisionAndConnect,
  SimClient,
  test,
  userScrollTo,
} from "./helpers.js";
import { longPress } from "./long-press.js";
import {
  measureTargets,
  round,
  settleAnimations,
  TARGET_MIN_PX,
  type OverlapPair,
  type TargetMeasurement,
} from "./touch-targets.js";

const ROOM = "ADH-376touchtargets1f2e3d4c";
const ROOM_TITLE = "Reach Room";
const PARTNER = "Pressley Vane";
const EICON = "tearsofjoy";

/**
 * Controls the floor does not apply to, keyed by their (de-hashed) class, with
 * the reason each one is here.
 *
 * There is exactly one reason on the list, and it is the §3 rule that outranks
 * the floor: every entry lives inside a line of message prose, where the
 * neighbours a 44px hit area would reach are the same kind of target on the
 * line above and the line below. Nothing is here for being merely awkward, and
 * an entry added later without that argument is a bug in the change.
 */
const PROSE_LINE =
  "inline in a message line — a 44px target reaches the line above and below, " +
  "where the neighbour is another one of these";

const EXCLUSIONS: Record<string, string> = {
  bodyLink: PROSE_LINE,
  bodyMention: PROSE_LINE,
  bodyChannel: PROSE_LINE,
  nameButton: PROSE_LINE,
  nick: PROSE_LINE,
  eiconChip: PROSE_LINE,
  bodyEicon: PROSE_LINE,
  eiconBlockedName: PROSE_LINE,
  spoiler: PROSE_LINE,
  // Not prose, and the one control here whose target is bigger than itself:
  // the whole 46px input bar is click-to-type (#313/#317), so the 22px
  // textarea inside it is not the thing a thumb has to find. Asserted
  // separately below rather than waved through.
  composerInput: "the input bar around it is the target (asserted separately)",
};

function excluded(target: TargetMeasurement): string | undefined {
  for (const name of target.classes) {
    const why = EXCLUSIONS[name];
    if (why !== undefined) {
      return why;
    }
  }
  return undefined;
}

test("phone device: every control on screen is a 44px target, and no two contest the same pixels (#376)", async ({
  page,
  browserName,
}) => {
  test.setTimeout(240_000);
  await interceptAvatars(page);

  await provisionAndConnect(page, "reachpalmer@example.test", "Reach Palmer");
  // The one surface in the walk that has to be *held* open (MP4, #378). CDP is
  // Chromium-only and Playwright's cross-engine touch API only taps, so on
  // WebKit that surface drops out of the sweep and every other one — the two
  // panes, the overflow menu, the member overlay, the inbox, the switcher, the
  // three preferences panes — is measured with the engine's own font metrics
  // and layout. Which is the half worth having here: a hit area is a *layout*
  // fact, and it is the second engine that says whether the boxes are the same
  // size. The sheet's own rows are pinned at 44px by menu-surface.module.css
  // and asserted in mobile-longpress.spec.ts on Chromium.
  const cdp =
    browserName === "webkit"
      ? undefined
      : await page.context().newCDPSession(page);

  const partner = await SimClient.connect(
    "pressley@example.test",
    "hunter2",
    PARTNER,
  );

  const measured: TargetMeasurement[] = [];
  const overlaps: OverlapPair[] = [];
  /** Measure whatever is on screen right now. Occluded controls (a shell
   * behind an open sheet) drop out of the walk on their own — the hit test
   * says so — which is what makes "the whole document" the right root for
   * every surface, dialog or not. */
  const seen = new Set<string>();
  const sweep = async (surface: string) => {
    await settleAnimations(page);
    const result = await measureTargets(page, surface, page.locator("body"));
    // A control keeps the surface it was first met on: the composer is still
    // on screen behind an anchored popover, and re-reporting it under every
    // surface that fails to cover it would bury the inventory in duplicates.
    for (const target of result.targets) {
      const key = `${target.label}|${target.selector}`;
      if (!seen.has(key)) {
        seen.add(key);
        measured.push(target);
      }
    }
    overlaps.push(...result.overlaps);
  };

  try {
    partner.send("PRI", {
      recipient: "Reach Palmer",
      message: `A direct line [eicon]${EICON}[/eicon]`,
    });
    await joinChannel(page, ROOM, ROOM_TITLE);
    partner.send("JCH", { channel: ROOM });
    await delay(400);
    for (let i = 1; i <= 24; i += 1) {
      partner.send("MSG", {
        channel: ROOM,
        message: `Line ${String(i)} with a name and an [eicon]${EICON}[/eicon]`,
      });
      await delay(70);
    }
    // …and one line that says the reader's name, so the notification inbox
    // has a row in it to measure rather than its empty note.
    partner.send("MSG", { channel: ROOM, message: "Reach Palmer, over here" });

    const shell = page.getByTestId("app-shell");
    const log = page.getByTestId("message-log");
    await expect(page.locator("html")).toHaveAttribute("data-layout", "phone");
    await expect(log.getByText("Line 24", { exact: false })).toBeVisible({
      timeout: 15_000,
    });

    // ── The conversation pane ────────────────────────────────────────────
    await sweep("conversation");

    // The composer's textarea is 22px of text inside a 46px bar, and the bar
    // is what a tap lands on (#313/#317) — so the bar is what has to clear the
    // floor. The exclusion list waves the textarea through on this promise;
    // this is the promise.
    const inputBar = page
      .getByRole("textbox", { name: "Message", exact: true })
      .locator("xpath=..");
    expect((await inputBar.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(
      TARGET_MIN_PX,
    );

    // ── …with the jump-to-recent pill up ─────────────────────────────────
    // It only exists while the log is away from the tail, so scroll it there.
    await userScrollTo(page, 0);
    const jump = page.getByTestId("jump-to-recent");
    await expect(jump).toBeVisible();
    await sweep("jump pill");
    await jump.tap();

    // ── The ⋯ overflow menu ──────────────────────────────────────────────
    const overflow = page.getByRole("button", {
      name: "More conversation actions",
    });
    await overflow.tap();
    const menu = page.getByRole("dialog", {
      name: "More conversation actions",
    });
    await expect(menu).toBeVisible();
    await sweep("overflow menu");

    // ── The member overlay, from that menu ───────────────────────────────
    await menu.getByRole("button", { name: "Toggle member list" }).tap();
    const members = page.getByRole("dialog", { name: "Members" });
    await expect(members).toBeVisible();
    await sweep("member overlay");
    await page.keyboard.press("Escape");

    // ── The notification inbox, with the mention in it ───────────────────
    await page.getByRole("button", { name: /^Notifications/u }).tap();
    const inbox = page.getByRole("dialog", { name: "Notifications" });
    await expect(inbox).toBeVisible();
    // The rows arrive from the server; sweeping the "Loading…" note would
    // measure a panel with nothing in it and call the surface covered.
    await expect(inbox.getByRole("button").first()).toBeVisible({
      timeout: 15_000,
    });
    await sweep("notification inbox");
    await page.keyboard.press("Escape");

    // ── A long-press action sheet (package A's rows are part of this) ────
    if (cdp !== undefined) {
      const eicon = log.getByRole("img", { name: EICON }).last();
      await expect(eicon).toBeVisible();
      await longPress(cdp, page, eicon);
      await expect(
        page.getByRole("dialog", { name: `${EICON} eicon menu` }),
      ).toBeVisible();
      await sweep("action sheet");
      await page.keyboard.press("Escape");
    }

    // ── The quick switcher ───────────────────────────────────────────────
    await page.keyboard.press("Control+k");
    const switcher = page.getByRole("dialog", { name: "Quick switcher" });
    await expect(switcher).toBeVisible();
    await sweep("quick switcher");
    await page.keyboard.press("Escape");

    // ── The list pane: folded rail strip, conversation rows, the MeBar ───
    await page.getByRole("link", { name: "Back to conversations" }).tap();
    await expect(shell).toHaveAttribute("data-pane", "list");
    await sweep("list pane");

    // ── Preferences, in the phone stopgap (MP1 §4) ───────────────────────
    // Three panes, not one: General is toggles, Appearance is where the
    // segmented controls, steppers and colour swatches live, and Highlights is
    // the rule chips. They are different control primitives, and a sweep of
    // the default pane would have measured none of them.
    await page.getByRole("button", { name: "Preferences" }).tap();
    const prefs = page.getByRole("dialog", { name: "Preferences" });
    await expect(prefs).toBeVisible();
    await sweep("preferences");
    await prefs.getByRole("button", { name: "Appearance" }).tap();
    await sweep("preferences: appearance");
    await prefs.getByRole("button", { name: "Highlights" }).tap();
    await sweep("preferences: highlights");
  } finally {
    partner.close();
  }

  // ── The inventory, printed whether or not it passes ────────────────────
  // The PR body's table is this output; a failure is read from the same rows.
  const rows = measured.map((target) => ({
    surface: target.surface,
    label: target.label,
    selector: target.selector,
    box: `${String(round(target.boxW))}×${String(round(target.boxH))}`,
    hit: `${String(round(target.ownW))}×${String(round(target.ownH))}`,
    ok: target.ownW >= TARGET_MIN_PX && target.ownH >= TARGET_MIN_PX,
    skip: excluded(target),
  }));
  console.table(
    rows.map((row) => ({
      ...row,
      skip: row.skip === undefined ? "" : "excluded",
    })),
  );

  const short = rows
    .filter((row) => !row.ok && row.skip === undefined)
    .map((row) => `${row.surface}: ${row.label} (${row.selector}) ${row.hit}`);

  // Sub-pixel slivers are layout rounding at a shared edge, not a contested
  // target: two chips whose claims touch report a 0.4px-wide intersection on a
  // fractional device scale. A finger cannot land in one.
  const contested = [
    ...new Set(
      overlaps
        .filter((pair) => pair.area >= 4)
        .map((pair) => `${pair.surface}: ${pair.a} ↔ ${pair.b}`),
    ),
  ];

  // Both lists before either assertion: a change that trips one usually trips
  // the other, and the two together say which of §3's rules it broke.
  expect(
    { short, contested },
    `the ${String(TARGET_MIN_PX)}px floor and the no-overlap rule`,
  ).toEqual({ short: [], contested: [] });
});
