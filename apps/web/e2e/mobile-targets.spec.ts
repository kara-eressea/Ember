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
// Two tests: the shell's own surfaces (#376), and the windows the shell opens
// (#487) — room settings, the channel browser, the profile viewer, the ad
// centre, character search. One file because they share the same measuring
// rig and the same pair of characters; two tests because the second one's
// setup (a room that takes ads, an ad in the library, a ban on the list) has
// nothing to do with the first one's backlog.
//
// Owns reachpalmer@example.test (Reach Palmer), pressley@example.test (Pressley
// Vane), the Reach Room and the Sweep Parlour: spec files run in parallel and a
// character holds one sim connection, so specs share neither.

import type { Locator, Page } from "@playwright/test";

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
const PARLOUR = "ADH-487windowsweep8c1d0e2f";
const PARLOUR_TITLE = "Sweep Parlour";
const PARTNER = "Pressley Vane";
const EICON = "tearsofjoy";

// The reasons a control is allowed off the floor. There are three of them,
// and every entry on EXCLUSIONS below has to name one: nothing is on that list
// for being merely awkward, and an entry added later without one of these
// arguments is a bug in the change.

/** The §3 rule that outranks the floor: the control lives inside a line of
 * message prose, where the neighbours a 44px hit area would reach are the same
 * kind of target on the line above and the line below. */
const PROSE_LINE =
  "inline in a message line — a 44px target reaches the line above and below, " +
  "where the neighbour is another one of these";

/** The control is smaller than the thing you actually press. An `input`
 * generates no pseudo-element boxes, so neither mechanism in §3 can reach a
 * native checkbox — but its `<label>` wraps text as well as box and toggles it,
 * and the phone rules grow that band to 44. Asserted by name below, the way the
 * composer's input bar is, rather than waved through on a promise. */
const LABEL_BAND =
  "a native checkbox — the label band around it is the target " +
  "(asserted separately)";

/** Controls the floor does not apply to, keyed by their (de-hashed) class. */
const EXCLUSIONS: Record<string, string> = {
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
  // The app's two native checkboxes (#487), both in the ad windows.
  disabledCheck: LABEL_BAND,
  selectAllCheck: LABEL_BAND,
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

/**
 * A walk in progress: an inventory, and a way to add one surface to it.
 *
 * `root` defaults to the whole document, which is the right root for the
 * shell's own surfaces — occluded controls (a pane behind an open sheet) drop
 * out on their own, because the hit test says so. A modal window passes its
 * own dialog instead: what is behind one of those is the shell, which the
 * first test has already measured, and re-measuring it under five more surface
 * names would bury the window's own rows in the inventory.
 */
function startSweep(page: Page) {
  const measured: TargetMeasurement[] = [];
  const overlaps: OverlapPair[] = [];
  // A control keeps the surface it was first met on: the composer is still on
  // screen behind an anchored popover, and re-reporting it under every surface
  // that fails to cover it would bury the inventory in duplicates.
  const seen = new Set<string>();

  const sweep = async (surface: string, root?: Locator): Promise<void> => {
    await settleAnimations(page);
    const result = await measureTargets(
      page,
      surface,
      root ?? page.locator("body"),
    );
    for (const target of result.targets) {
      const key = `${target.label}|${target.selector}`;
      if (!seen.has(key)) {
        seen.add(key);
        measured.push(target);
      }
    }
    overlaps.push(...result.overlaps);
  };

  return { measured, overlaps, sweep };
}

/**
 * Print the inventory — pass or fail — and assert §3's two rules over it.
 *
 * The PR body's tables are this output, and a failure is read from the same
 * rows, which is why the printing happens before either assertion rather than
 * inside a reporter.
 */
function report(
  measured: readonly TargetMeasurement[],
  overlaps: readonly OverlapPair[],
): void {
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

  const { measured, overlaps, sweep } = startSweep(page);

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
  report(measured, overlaps);
});

/**
 * The windows the shell opens (#487).
 *
 * Package C swept what is on screen when the app is; these five are what a tap
 * puts in front of it — and every one of them was written as a desktop window,
 * so opening them on a phone is half the work. They are one test rather than
 * five: the expensive part is the login, the room and the ad in the library,
 * not the dialogs, and five page loads would be five times the wall clock for
 * the same measurements.
 *
 * No CDP here, so this one runs on WebKit too — the whole walk is taps.
 */
test("phone device: every control in a secondary window is a 44px target (#487)", async ({
  page,
}) => {
  test.setTimeout(300_000);
  await interceptAvatars(page);

  await provisionAndConnect(page, "reachpalmer@example.test", "Reach Palmer");
  const partner = await SimClient.connect(
    "pressley@example.test",
    "hunter2",
    PARTNER,
  );

  const { measured, overlaps, sweep } = startSweep(page);

  try {
    await expect(page.locator("html")).toHaveAttribute("data-layout", "phone");

    // ── The channel browser ──────────────────────────────────────────────
    // Both tabs: the official list and the open-rooms list are different rows
    // (a Join button against a member count), and the tab strip is a control
    // of the surface in its own right.
    await page.getByRole("button", { name: "Browse channels" }).tap();
    const browser = page.getByRole("dialog", { name: "Browse channels" });
    await expect(browser.getByText("Orchard")).toBeVisible({ timeout: 15_000 });
    await sweep("channel browser", browser);
    await browser.getByRole("tab", { name: /Open rooms/u }).tap();
    await sweep("channel browser: open rooms", browser);

    // …and the footer is how the sweep gets into its own room, which is where
    // every other window here is opened from.
    await browser.getByLabel("Join a hidden channel by name").fill(PARLOUR);
    await browser.getByRole("button", { name: "Join", exact: true }).tap();
    await expect(browser).not.toBeVisible({ timeout: 15_000 });
    await expect(
      page.getByRole("heading", { name: PARLOUR_TITLE }),
    ).toBeVisible();
    partner.send("JCH", { channel: PARLOUR });

    // ── The profile viewer, opened the way a phone opens it ──────────────
    // Member overlay → the row's mini card → "Open profile". The card clears
    // itself on the hand-off (§13), so nothing of it is left on screen to be
    // measured here — the mini card is the shell's surface, not this one's.
    const overflow = page.getByRole("button", {
      name: "More conversation actions",
    });
    const menu = page.getByRole("dialog", {
      name: "More conversation actions",
    });
    await overflow.tap();
    await menu.getByRole("button", { name: "Toggle member list" }).tap();
    const members = page.getByRole("dialog", { name: "Members" });
    await expect(members.getByText(PARTNER)).toBeVisible({ timeout: 15_000 });
    await members.getByText(PARTNER).tap();
    const card = page.getByRole("dialog", { name: `Profile card: ${PARTNER}` });
    await card.getByRole("button", { name: "Open profile" }).tap();
    const viewer = page.getByRole("dialog", { name: `Profile: ${PARTNER}` });
    // The tabs only exist once the profile itself has arrived; sweeping the
    // skeleton would measure a window with nothing in it and call it covered.
    await expect(viewer.getByRole("tab", { name: "Kinks" })).toBeVisible({
      timeout: 15_000,
    });
    await sweep("profile viewer", viewer);
    // Every tab, and read off the strip rather than named here: they are seven
    // different control sets (a kink grid, an image wall, a guestbook, a note
    // editor), a sweep of the default one would have measured none of them,
    // and a tab added next month should not need this file edited. Taking the
    // labels first, because tapping one re-renders the strip.
    const tabs = await viewer.getByRole("tab").allInnerTexts();
    for (const label of tabs) {
      await viewer.getByRole("tab", { name: label, exact: true }).tap();
      if (label === "Insights") {
        // The one pane that fetches when it opens: sweeping it while the
        // shimmer is still up measures the tab strip and nothing under it,
        // and the private note is the tallest thing this window keeps below
        // the fold.
        await expect(
          viewer.getByRole("button", { name: "+ Add private note" }),
        ).toBeVisible({ timeout: 15_000 });
      }
      await sweep(`profile viewer: ${label.toLowerCase()}`, viewer);
    }
    await page.keyboard.press("Escape");
    await expect(viewer).not.toBeVisible();
    await page.keyboard.press("Escape");

    // ── The ad centre, and the two windows it opens ──────────────────────
    await page.getByRole("button", { name: "Open the Ad Center" }).tap();
    const ads = page.getByRole("dialog", { name: "Ad Center" });
    await expect(ads).toBeVisible();
    await sweep("ad centre", ads);
    await ads.getByRole("button", { name: "Write your first ad" }).tap();
    await ads
      .getByRole("textbox", { name: "Ad text" })
      .fill("**Sweeping** the parlour, slowly.");
    await ads.getByRole("textbox", { name: "Add tag" }).fill("parlour");
    await ads.getByRole("textbox", { name: "Add tag" }).press("Enter");
    await ads.getByRole("button", { name: "Save ad" }).tap();
    await expect(ads.getByText("Saved", { exact: true })).toBeVisible();
    await sweep("ad centre: editor", ads);

    // …and again with the foot of the editor scrolled up. The tag row is
    // below the fold on a phone, and a control half-scrolled out of its list
    // is not measured where it is cut (touch-targets.ts) — so it has to be
    // brought into view rather than reported as short from under the footer.
    await ads
      .getByRole("textbox", { name: "Add tag" })
      .scrollIntoViewIfNeeded();
    await sweep("ad centre: editor tags", ads);

    // The first of the two native checkboxes the exclusion list waves through
    // on LABEL_BAND's promise; this is the promise. The band, not the box: a
    // tap anywhere on "Disabled / kept, skipped when posting" toggles it.
    expect(
      (
        await ads
          .locator("label", { hasText: "Disabled" })
          .first()
          .boundingBox()
      )?.height ?? 0,
    ).toBeGreaterThanOrEqual(TARGET_MIN_PX);

    await ads.getByRole("button", { name: "Post ads…" }).tap();
    const post = page.getByRole("dialog", { name: "Post ads" });

    // The channel list needs a moment of patience: the cooldown reply lands a
    // few milliseconds *after* the render clock the dialog compares it
    // against, so a freshly-opened Post ads reads its own clear channel as
    // "waiting" until the 15s tick corrects it — and reopening just repeats
    // the race, which is why this is a wait rather than a reopen. Sweeping the
    // edge state instead would measure three buttons and none of the rows.
    await expect(
      post.getByRole("button", { name: new RegExp(PARLOUR_TITLE, "u") }),
    ).toBeVisible({ timeout: 30_000 });
    await sweep("post ads", post);

    // …and the second one, "Select all eligible".
    expect(
      (
        await post
          .locator("label", { hasText: "Select all eligible" })
          .first()
          .boundingBox()
      )?.height ?? 0,
    ).toBeGreaterThanOrEqual(TARGET_MIN_PX);

    // The campaign window's setup screen, off the Rotate… slot — which hands
    // over rather than stacking, so Post ads is gone by the time it is up. The
    // live status screen is not swept: reaching it means starting a rotation
    // that posts into the room for the rest of the test, and its controls are
    // the same primitives (rows, a segmented switch, a footer button) the
    // setup screen already has under the measurement.
    await post.getByRole("button", { name: "↻ Rotate…" }).tap();
    const campaign = page.getByRole("dialog", { name: "Set up a campaign" });
    await expect(
      campaign.getByRole("button", { name: new RegExp(PARLOUR_TITLE, "u") }),
    ).toBeVisible({ timeout: 15_000 });
    await sweep("campaign setup", campaign);

    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await expect(ads).not.toBeVisible();

    // ── Room settings, with a name on the banlist ────────────────────────
    // The ban goes in first so the banned-characters pane has a row rather
    // than its empty note — the row and its "Lift ban" are the pane's only
    // repeating control.
    const composer = page.getByRole("textbox", {
      name: "Message",
      exact: true,
    });
    await composer.fill(`/ban ${PARTNER}`);
    await composer.press("Enter");
    await expect(
      page.getByText(`${PARTNER} was banned from the channel by Reach Palmer.`),
    ).toBeVisible({ timeout: 15_000 });

    await overflow.tap();
    await menu.getByRole("button", { name: "Room settings" }).tap();
    const room = page.getByRole("dialog", {
      name: `Room settings — ${PARLOUR_TITLE}`,
    });
    await expect(room).toBeVisible();
    await sweep("room settings", room);
    await room
      .getByRole("button", { name: "Banned characters", exact: true })
      .tap();
    await expect(
      room.getByRole("button", { name: `Lift ban on ${PARTNER}` }),
    ).toBeVisible({ timeout: 15_000 });
    await sweep("room settings: bans", room);
    // …and lifted again, through the same button. The sim's world outlives
    // this test — the WebKit pass runs this file again against the same room —
    // and a Pressley Vane who is still banned never reaches the member list
    // the profile viewer is opened from.
    await room.getByRole("button", { name: `Lift ban on ${PARTNER}` }).tap();
    await expect(
      room.getByText("No one is banned from this room."),
    ).toBeVisible({ timeout: 15_000 });
    await page.keyboard.press("Escape");

    // ── Character search ─────────────────────────────────────────────────
    await page.getByRole("link", { name: "Back to conversations" }).tap();
    await page.getByRole("button", { name: "Search characters" }).tap();
    const search = page.getByRole("dialog", { name: "Search characters" });
    await expect(search).toBeVisible();
    await sweep("character search", search);
    // The kink picker is the surface inside the surface, and the only place in
    // the app where a list of 700 rows is filtered down to a tap target.
    await search.getByRole("button", { name: "+ Add kinks…" }).tap();
    await search
      .getByRole("textbox", { name: "Search kinks" })
      .fill("Campfire");
    await expect(
      search.getByRole("button", { name: /Campfire Stories/u }),
    ).toBeVisible({ timeout: 15_000 });
    await sweep("character search: kink picker", search);
    await search.getByRole("button", { name: /Campfire Stories/u }).tap();
    await search.getByRole("button", { name: "Done" }).tap();
    await search.getByRole("button", { name: "Search", exact: true }).tap();
    await expect(
      search.getByRole("button", { name: /Nyx Firemane/u }),
    ).toBeVisible({ timeout: 20_000 });
    await sweep("character search: results", search);

    // …and one saved search, which is the only way the rail strip has a row
    // in it rather than its empty note.
    await search.getByRole("button", { name: "☆ Save current" }).tap();
    await search
      .getByRole("textbox", { name: "Saved search name" })
      .fill("Parlour folk");
    await search
      .getByRole("textbox", { name: "Saved search name" })
      .press("Enter");
    await expect(search.getByText("Parlour folk")).toBeVisible();
    await sweep("character search: saved", search);
  } finally {
    partner.close();
  }

  report(measured, overlaps);
});
