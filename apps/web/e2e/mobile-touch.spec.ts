// Touch affordances on a real touch context (#375, MP1 package F, verified by
// package G). Runs in the `mobile-chromium` project, whose device descriptor
// is the whole point here: `hover: none` is what both fallbacks key off, and
// it cannot be set with `page.emulateMedia` — only a mobile context reports
// it. A desktop project resizing itself to 393px would still hover, so these
// two paths were unreachable from the existing suite by construction.
//
// The two of them: a control that is only painted on :hover (the sidebar
// row's ✕) has to be visible and tappable where nothing can hover, and a
// preview that only opens on mouseenter (the name-only eicon chip) has to
// open on a tap instead.
//
// Owns thumb@example.test (Thumb Reeve) and chipwarren@example.test (Chip
// Warren): spec files run in parallel and a character holds one sim
// connection, so specs share neither.

import {
  expect,
  interceptAvatars,
  provisionAndConnect,
  SimClient,
  test,
} from "./helpers.js";

const PARTNER = "Chip Warren";
const EICON = "tearsofjoy";

test("phone device: hover-only affordances are reachable by tap (#375)", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await interceptAvatars(page);

  await provisionAndConnect(page, "thumb@example.test", "Thumb Reeve");

  const partner = await SimClient.connect(
    "chipwarren@example.test",
    "hunter2",
    PARTNER,
  );
  try {
    // ── Name-only eicons, so there is a chip to tap further down ─────────
    await page.getByRole("button", { name: "Preferences" }).click();
    const prefs = page.getByRole("dialog", { name: "Preferences" });
    await prefs.getByRole("button", { name: "Appearance" }).click();
    await prefs.getByRole("radio", { name: "Name only" }).click();
    await expect(
      prefs.getByRole("radio", { name: "Name only" }),
    ).toHaveAttribute("aria-checked", "true");
    await prefs.getByRole("button", { name: "Close preferences" }).click();

    const sidebar = page
      .getByRole("navigation")
      .filter({ has: page.getByLabel("Filter the channel list") });
    const dmRow = sidebar.getByRole("link", { name: new RegExp(PARTNER) });
    const close = sidebar.getByRole("button", {
      name: `Close conversation with ${PARTNER}`,
    });

    partner.send("PRI", { recipient: "Thumb Reeve", message: "Knock knock." });
    await expect(dmRow).toBeVisible({ timeout: 15_000 });

    // ── The row's ✕ is painted with no pointer to reveal it ──────────────
    // Park the mouse in the corner first: every click above moved it, and a
    // pointer resting on the row would satisfy `.navRowWrap:hover .navClose`
    // and pass this for the wrong reason. `toBeVisible()` would not catch the
    // bug either — Playwright counts an `opacity: 0` element as visible,
    // which is exactly the state a touchscreen was stuck in before package F.
    await page.mouse.move(0, 0);
    await expect(close).toHaveCSS("opacity", "1");
    // …and it is a real control, not just a painted one.
    await close.tap();
    await expect(dmRow).toHaveCount(0);

    // ── An inbound message reopens it, and the row comes back ────────────
    partner.send("PRI", {
      recipient: "Thumb Reeve",
      message: `Reporting in [eicon]${EICON}[/eicon]`,
    });
    await dmRow.click({ timeout: 15_000 });
    await expect(page.getByTestId("app-shell")).toHaveAttribute(
      "data-pane",
      "conversation",
    );

    // ── The eicon chip previews on a tap, because it cannot on hover ─────
    const chip = page
      .getByTestId("message-log")
      .getByRole("button", { name: `${EICON} — show eicon` });
    await expect(chip).toBeVisible({ timeout: 15_000 });
    await expect(chip).toHaveAttribute("aria-expanded", "false");
    await chip.tap();
    await expect(chip).toHaveAttribute("aria-expanded", "true");
    await expect(chip.getByRole("img", { name: EICON })).toBeVisible();
    // A second tap puts it away: on a touchscreen the chip is the only
    // handle, so a preview that cannot be closed would cover the rows under
    // it for good.
    await chip.tap();
    await expect(chip).toHaveAttribute("aria-expanded", "false");
  } finally {
    partner.close();
  }
});
