// Preferences on the phone tier — the MP1 §4 stopgap, which MP2 package C
// actually built (#376).
//
// The bug this guards is specific and was shipped for a while: MP1 wrote down
// "stack the section rail above the pane and let the whole dialog go
// full-screen" and shipped without it, leaving the desktop two-column dialog
// squeezed into 361px — a 204px rail beside a 157px pane. A pane that narrow
// cannot hold its own controls, and the highlight-rule form's segmented switch
// was simply clipped off the right edge of the window, where no pointer of any
// kind could reach it.
//
// Which is why the assertion here is geometric rather than a tap. A tap alone
// would pass on the broken layout: Playwright scrolls an element into view
// before clicking it, and the clipped switch was in a container that could be
// scrolled — by a test, and by nothing a user has. So the claim is that the
// control is *on screen where it sits*, and only then that it works.
//
// mobile-targets.spec.ts sweeps these same three panes for 44px hit areas, and
// deliberately does not overlap: its sweep hit-tests what is on screen, so a
// control clipped off the edge drops out of the walk silently rather than
// failing it. The two specs are the two halves of "reachable" — big enough for
// a thumb, and actually there.
//
// Owns dial@example.test (Dial Ashcombe): spec files run in parallel and a
// character holds one sim connection, so specs share neither (world.ts).

import type { Page } from "@playwright/test";
import {
  expect,
  interceptAvatars,
  provisionAndConnect,
  test,
} from "./helpers.js";

const CHARACTER = "Dial Ashcombe";

/** The page must never scroll sideways on a phone (mobile-shell's rule). */
function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth,
  );
}

/** Every pane the rail offers, in order. The last ones are what make the strip
 * a scrolling one on a 393px screen. */
const SECTIONS = [
  "General",
  "Appearance",
  "Highlights",
  "Away & logs",
  "Notifications",
  "Network",
];

test("phone device: preferences go full-screen, the rail turns on its side, and the rule switch is on screen (#376)", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await interceptAvatars(page);

  await provisionAndConnect(page, "dial@example.test", CHARACTER);
  await expect(page.locator("html")).toHaveAttribute("data-layout", "phone");

  const viewport = page.viewportSize();
  const width = viewport?.width ?? 0;
  const height = viewport?.height ?? 0;

  await page.getByRole("button", { name: "Preferences" }).tap();
  const prefs = page.getByRole("dialog", { name: "Preferences" });
  await expect(prefs).toBeVisible();

  // ── Full-screen, not a 748×560 window scaled down ──────────────────────
  const windowBox = await prefs.boundingBox();
  expect(windowBox?.width).toBeCloseTo(width, 0);
  expect(windowBox?.height).toBeCloseTo(height, 0);

  // ── The rail is a strip above the pane, not a column beside it ─────────
  // Read off the geometry rather than the stylesheet: "flex-direction: row"
  // is the implementation, "the second section sits to the right of the
  // first, and the pane sits below both" is the layout that has to hold.
  const rail = prefs.getByRole("navigation", { name: "Preference sections" });
  const first = await rail
    .getByRole("button", { name: SECTIONS[0] ?? "" })
    .boundingBox();
  const second = await rail
    .getByRole("button", { name: SECTIONS[1] ?? "" })
    .boundingBox();
  expect(second?.x ?? 0).toBeGreaterThan(first?.x ?? 0);
  expect(second?.y).toBeCloseTo(first?.y ?? 0, 0);
  const railBox = await rail.boundingBox();
  expect(railBox?.width).toBeCloseTo(width, 0);
  // The pane starts under the strip, and gets the rest of the window.
  const paneTop = (railBox?.y ?? 0) + (railBox?.height ?? 0);
  expect(paneTop).toBeLessThan(height / 3);

  // ── Every section is reachable through the strip ───────────────────────
  // Six sections do not fit across 393px, so the last of them are behind the
  // strip's own horizontal scroll — which is the affordance, and the thing
  // that has to work rather than be clipped away.
  for (const section of SECTIONS) {
    await rail.getByRole("button", { name: section }).tap();
    await expect(prefs.getByRole("heading", { name: section })).toBeVisible();
    // …and the page itself never scrolls sideways while it happens.
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
  }

  // ── The control the stopgap exists for ─────────────────────────────────
  await rail.getByRole("button", { name: "Highlights" }).tap();
  const kinds = prefs.getByRole("radiogroup", { name: "Rule kind" });
  await expect(kinds).toBeVisible();
  const kindsBox = await kinds.boundingBox();
  expect(kindsBox?.x ?? -1).toBeGreaterThanOrEqual(0);
  expect((kindsBox?.x ?? 0) + (kindsBox?.width ?? 0)).toBeLessThanOrEqual(
    width,
  );

  // Each segment, individually: the group fitting is not the same as its last
  // segment fitting, and "Regex" is the one that used to be over the edge.
  for (const kind of ["Word", "Nick", "Regex"]) {
    const box = await kinds.getByRole("radio", { name: kind }).boundingBox();
    expect(box?.x ?? -1).toBeGreaterThanOrEqual(0);
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(width);
  }

  // …and it is a live control, not a painted one.
  await kinds.getByRole("radio", { name: "Regex" }).tap();
  await expect(kinds.getByRole("radio", { name: "Regex" })).toHaveAttribute(
    "aria-checked",
    "true",
  );

  // The rest of the form the switch belongs to, on the same terms: a rule is
  // added from this pane or from nowhere.
  await prefs.getByRole("radio", { name: "Word" }).tap();
  await prefs.getByRole("textbox", { name: "Rule pattern" }).fill("lantern");
  await prefs.getByRole("button", { name: "Add", exact: true }).tap();
  await expect(
    prefs.getByRole("list", { name: "Highlight rules" }).getByText("lantern"),
  ).toBeVisible({ timeout: 15_000 });
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
});
