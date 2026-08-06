// The auth screens on a phone (#535, #536, #537). Runs in the
// `mobile-chromium` project and again on WebKit, where `hover: none`, a coarse
// pointer and the device's own font metrics are the device's answers rather
// than a resized desktop's.
//
// These two screens sat outside AppShell and predate the layout tiers, so the
// MP rounds swept the shell around them and left them as they were: a 400px
// card floating on a darkened page, three chips of similar weight in a row,
// and a wordmark that was not the one the app wears. All three tests measure
// rather than inspect — the panel's box, not its class list (the MP4 lesson);
// the controls' hit areas by hit test, not by rect (the MP2 census's, since
// the ::after overlay the floor is carried by has no node to report).
//
// Owns latchward@example.test (Latch Ward, Latch Fen). Spec files run in
// parallel and a character holds one sim connection, so no other spec may
// name either; the two tests here share the account safely because tests
// within a file run serially in one worker.
//
// No CDP anywhere: the whole file is taps and box reads, so WebKit runs all of
// it.

import {
  expect,
  interceptAvatars,
  provisionAndConnect,
  provisionUser,
  test,
} from "./helpers.js";
import {
  measureTargets,
  round,
  settleAnimations,
  TARGET_MIN_PX,
  type OverlapPair,
  type TargetMeasurement,
} from "./touch-targets.js";
import type { Locator, Page } from "@playwright/test";

const ACCOUNT = "latchward@example.test";
const CHARACTER = "Latch Ward";

/** The one control on these screens the floor cannot reach: a native
 * `<input type="checkbox">` generates no pseudo-element boxes, so what a
 * thumb is given is the `<label>` band around it — asserted by name below
 * rather than waved through on a promise. */
const LABEL_BAND =
  "a native checkbox — the label band around it is the target " +
  "(asserted separately)";

const EXCLUSIONS: Record<string, string> = { checkbox: LABEL_BAND };

function excluded(target: TargetMeasurement): string | undefined {
  for (const name of target.classes) {
    const why = EXCLUSIONS[name];
    if (why !== undefined) {
      return why;
    }
  }
  return undefined;
}

/** "This panel is the screen." A box read, not a class read: whether the tier
 * took effect is a question about pixels, and a rule that is present but
 * losing the cascade passes every class assertion ever written. */
async function expectFullBleed(page: Page, panel: Locator): Promise<void> {
  const viewport = page.viewportSize();
  expect(viewport).not.toBeNull();
  const box = await panel.boundingBox();
  expect(box).not.toBeNull();
  // A pixel of tolerance on each edge: fractional device scale lands layout on
  // halves, and a panel one third of a pixel short of the edge is not a card.
  expect({
    left: box!.x <= 1,
    width: box!.width >= viewport!.width - 1,
    height: box!.height >= viewport!.height - 1,
  }).toEqual({ left: true, width: true, height: true });
}

/** Measure every operable control on a surface and assert §3's two rules over
 * it. The inventory prints pass or fail — a failure is read from the same
 * rows the PR's evidence is. */
async function expectTargets(
  page: Page,
  surface: string,
  root: Locator,
): Promise<TargetMeasurement[]> {
  await settleAnimations(page);
  const { targets, overlaps } = await measureTargets(page, surface, root);
  console.table(
    targets.map((target) => ({
      surface: target.surface,
      label: target.label,
      selector: target.selector,
      box: `${String(round(target.boxW))}×${String(round(target.boxH))}`,
      hit: `${String(round(target.ownW))}×${String(round(target.ownH))}`,
      ok: target.ownW >= TARGET_MIN_PX && target.ownH >= TARGET_MIN_PX,
      skip: excluded(target) === undefined ? "" : "excluded",
    })),
  );

  const short = targets
    .filter(
      (target) =>
        excluded(target) === undefined &&
        (target.ownW < TARGET_MIN_PX || target.ownH < TARGET_MIN_PX),
    )
    .map(
      (target) =>
        `${target.surface}: ${target.label} (${target.selector}) ` +
        `${String(round(target.ownW))}×${String(round(target.ownH))}`,
    );

  // Sub-pixel slivers are layout rounding at a shared edge, not a contested
  // target: a finger cannot land in one.
  const contested = [
    ...new Set(
      (overlaps as readonly OverlapPair[])
        .filter((pair) => pair.area >= 4)
        .map((pair) => `${pair.surface}: ${pair.a} ↔ ${pair.b}`),
    ),
  ];

  expect(
    { short, contested },
    `the ${String(TARGET_MIN_PX)}px floor and the no-overlap rule`,
  ).toEqual({ short: [], contested: [] });
  return targets;
}

test("phone: every auth screen fills the screen, and every control on it is a 44px target (#535)", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await interceptAvatars(page);
  const creds = await provisionUser();

  await page.goto("/login");
  await expect(page.locator("html")).toHaveAttribute("data-layout", "phone");
  const panel = page.getByTestId("auth-panel");
  await expect(panel).toBeVisible();

  // ── The login screen ─────────────────────────────────────────────────
  await expectFullBleed(page, panel);
  await expectTargets(page, "login", panel);

  // The exclusion list waves the "Keep me signed in" checkbox through on
  // LABEL_BAND's promise; this is the promise. The band, not the box: a tap
  // anywhere on the words toggles it.
  const keepBand = page.locator("label", { hasText: "Keep me signed in" });
  expect((await keepBand.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(
    TARGET_MIN_PX,
  );

  // The wordmark is the product name, not a literal (#537, #556). The document
  // title is the same constant, so this compares the two renderings of it
  // rather than against a string this file made up.
  const appName = await page.evaluate(() => document.title);
  expect(appName).not.toBe("");
  await expect(page.getByTestId("wordmark")).toHaveText(appName);

  // ── The identity picker, with nothing in it yet ──────────────────────
  await page.getByLabel("Email").fill(creds.email);
  await page.getByLabel("Password").fill(creds.password);
  await page.getByRole("button", { name: "Log in" }).tap();
  await expect(page).toHaveURL(/\/identities$/);
  await expect(
    page.getByRole("button", { name: "Add a server identity" }),
  ).toBeVisible({ timeout: 15_000 });
  await expectFullBleed(page, panel);
  await expect(page.getByTestId("wordmark")).toHaveText(appName);
  await expectTargets(page, "identity picker", panel);

  // ── The add flow: the account form, then the character grid ──────────
  await page.getByRole("button", { name: "Add a server identity" }).tap();
  await expect(page.getByLabel("F-List account name")).toBeVisible();
  await expectTargets(page, "add account", panel);

  await page.getByLabel("F-List account name").fill(ACCOUNT);
  await page.getByLabel("F-List password").fill("hunter2");
  await page.getByRole("button", { name: "Verify account" }).tap();
  // The character list arrives from the throttled (≤1 req/s) F-List ticket
  // budget, queued behind whatever else the run is provisioning.
  await expect(
    page.getByRole("listitem").filter({ hasText: CHARACTER }),
  ).toBeVisible({ timeout: 15_000 });
  await expectTargets(page, "character grid", panel);
});

test("phone: Open and Disconnect cannot be confused for each other (#536)", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await interceptAvatars(page);
  await provisionAndConnect(page, ACCOUNT, CHARACTER);

  // Back on the picker, the live identity's row carries both actions.
  await page.goto("/identities");
  await expect(page.locator("html")).toHaveAttribute("data-layout", "phone");
  const panel = page.getByTestId("auth-panel");
  await expect(
    page.getByRole("button", { name: "Open", exact: true }),
  ).toBeVisible({ timeout: 15_000 });
  await expectFullBleed(page, panel);

  const targets = await expectTargets(page, "identity picker: live row", panel);

  // …and the two of them in particular. Classes rather than labels, because
  // the labels are what a redesign moves.
  const open = targets.find((target) =>
    target.classes.includes("connectButton"),
  );
  const disconnect = targets.find((target) =>
    target.classes.includes("disconnectButton"),
  );
  expect(
    { open: open !== undefined, disconnect: disconnect !== undefined },
    "both actions were measured",
  ).toEqual({ open: true, disconnect: true });

  // The gap comes off the painted boxes, not off the census's claim rects:
  // those are scanned outward from each centre and stop at the scan margin, so
  // for a control wider than that they never reach its own edge and the
  // subtraction would flatter itself. The boxes are the honest edges here
  // precisely because neither control is short in this axis — both are wider
  // than 44, so the ::after overlay adds nothing sideways and the hit areas end
  // where the boxes do. (That the two do not contest a pixel at all is what
  // expectTargets already asserted, by hit test.)
  const openBox = await page
    .getByRole("button", { name: "Open", exact: true })
    .boundingBox();
  const disconnectBox = await page
    .getByRole("button", { name: "Disconnect", exact: true })
    .boundingBox();
  const gap = disconnectBox!.x - (openBox!.x + openBox!.width);
  expect(
    {
      openHit: open!.ownW >= TARGET_MIN_PX && open!.ownH >= TARGET_MIN_PX,
      disconnectHit:
        disconnect!.ownW >= TARGET_MIN_PX && disconnect!.ownH >= TARGET_MIN_PX,
      // MP2's adjacency rule: the row opens up rather than shipping two
      // targets fighting over the pixels between them.
      gapIsReal: gap >= 12,
    },
    `Open ${String(round(open!.ownW))}×${String(round(open!.ownH))}, ` +
      `Disconnect ${String(round(disconnect!.ownW))}×${String(round(disconnect!.ownH))}, ` +
      `gap ${String(round(gap))}px`,
  ).toEqual({ openHit: true, disconnectHit: true, gapIsReal: true });

  // One tap arms rather than acts. Mis-tapping Open costs a Back press;
  // mis-tapping this costs the held session, so on this tier it asks.
  await page.getByRole("button", { name: "Disconnect", exact: true }).tap();
  const armed = page.getByRole("button", {
    name: new RegExp(`Confirm ending ${CHARACTER}`, "u"),
  });
  await expect(armed).toHaveText("Disconnect?");
  await expect(
    page.getByText(new RegExp(`${ACCOUNT} · online`, "u")),
  ).toBeVisible();

  // The second tap is the one that drops it.
  await armed.tap();
  await expect(
    page.getByText(new RegExp(`${ACCOUNT} · offline`, "u")),
  ).toBeVisible({ timeout: 15_000 });
  await expect(
    page.getByRole("button", { name: "Connect", exact: true }),
  ).toBeVisible({ timeout: 15_000 });
});
