// The M5 preferences-window E2E (COMPONENTS.md §12): the MeBar gear opens
// the modal, the rail switches panes, Escape and the backdrop close it, and
// the Appearance pane's accent choice persists across a reload AND a second
// device (the milestone-5.md verification target — prefs live server-side).
// Owns hazel@example.test (Hazel Fenwick) — spec files run in parallel and
// a character can hold only one sim connection, so specs never share one.

import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import {
  SimClient,
  interceptAvatars,
  joinChannel,
  provisionAndConnect,
} from "./helpers.js";

/** The applied accent, straight from the theme's CSS custom property. */
function appliedAccent(page: Page): Promise<string> {
  return page.evaluate(() =>
    getComputedStyle(document.documentElement)
      .getPropertyValue("--eb-accent")
      .trim(),
  );
}

const MOSS = "#88ac72";

test("preferences window: gear, pane nav, accent persists across reload + devices", async ({
  page,
  browser,
}) => {
  test.setTimeout(180_000);
  await interceptAvatars(page);

  const creds = await provisionAndConnect(
    page,
    "hazel@example.test",
    "Hazel Fenwick",
  );

  // Gear → window. General is the landing pane.
  await page.getByRole("button", { name: "Preferences" }).click();
  const dialog = page.getByRole("dialog", { name: "Preferences" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("heading", { name: "General" })).toBeVisible();
  const accountLink = dialog.getByRole("link", { name: /F-List account/ });
  await expect(accountLink).toBeVisible();
  await expect(accountLink).toHaveAttribute(
    "href",
    "https://www.f-list.net/account_settings.php",
  );
  // The About surface shows the running version (M7 step 5).
  await expect(dialog.getByText(/EmberChat v0\.0\.0/)).toBeVisible();

  // Rail nav switches the pane.
  await dialog.getByRole("button", { name: "Appearance" }).click();
  await expect(
    dialog.getByRole("heading", { name: "Appearance" }),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "Away & logs" }).click();
  await expect(
    dialog.getByRole("heading", { name: "Away & logs" }),
  ).toBeVisible();

  // Escape closes.
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();

  // Reopen; the ✕ closes too.
  await page.getByRole("button", { name: "Preferences" }).click();
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Close preferences" }).click();
  await expect(dialog).not.toBeVisible();

  // ── Join/part/quit lines (M5 step 5): live-only, gated by the pref ────
  await joinChannel(page, "Terrarium");

  await page.getByRole("button", { name: "Preferences" }).click();
  await dialog.getByRole("button", { name: "Appearance" }).click();
  await dialog.getByRole("switch", { name: "Show join/part/quit" }).click();
  await page.keyboard.press("Escape");

  // The account's second character wanders in and out via a raw sim client.
  const sprout = await SimClient.connect(
    "hazel@example.test",
    "hunter2",
    "Fenwick Sprout",
  );
  try {
    sprout.send("JCH", { channel: "Terrarium" });
    await expect(
      page.getByTestId("presence-line").filter({ hasText: "Fenwick Sprout" }),
      // The line now leads with a timestamp column (#208), so match the
      // message text rather than the full line.
    ).toContainText("Fenwick Sprout joined", { timeout: 10_000 });
  } finally {
    sprout.close();
  }
  // The socket drop is an FLN — the quit line follows the join line.
  await expect(
    page.getByTestId("presence-line").filter({ hasText: "went offline" }),
  ).toContainText("Fenwick Sprout went offline", { timeout: 10_000 });

  // ── #294 regression: a prefs input keeps focus across a shell re-render ─
  // The image-preview host field (a General pane text input — the Link
  // previews group moved here in #392) used to be yanked back to the dialog
  // whenever anything re-rendered AppShell — the window's focus effect re-ran
  // on every parent render because its onClose dep was a fresh arrow each
  // time. Focus the field, type half an entry, let a live presence event
  // re-render the shell underneath it, then finish typing: every keystroke
  // must still land in the field, and it must keep focus. (Any store update —
  // the prefs-sync round trip, presence — hits the same path; presence is the
  // deterministic, awaitable trigger here.)
  await page.getByRole("button", { name: "Preferences" }).click();
  await dialog.getByRole("button", { name: "General" }).click();
  // #392: the Link previews group (mode selector + host allowlist) lives on
  // the General pane now — its mode control renders here alongside the editor.
  await expect(
    dialog.getByRole("radiogroup", { name: "Media link previews" }),
  ).toBeVisible();
  const hostField = dialog.getByRole("textbox", { name: "Site address" });
  await hostField.click();
  await hostField.pressSequentially("exam");
  const linesBefore = await page.getByTestId("presence-line").count();
  const sproutFocus = await SimClient.connect(
    "hazel@example.test",
    "hunter2",
    "Fenwick Sprout",
  );
  try {
    sproutFocus.send("JCH", { channel: "Terrarium" });
    // A fresh presence line proves the store updated and the shell
    // re-rendered under the open, focused input.
    await expect
      .poll(() => page.getByTestId("presence-line").count(), {
        timeout: 10_000,
      })
      .toBeGreaterThan(linesBefore);
  } finally {
    sproutFocus.close();
  }
  await hostField.pressSequentially("ple.com");
  await expect(hostField).toBeFocused();
  await expect(hostField).toHaveValue("example.com");

  // ── Allowlist editing (#215): submit adds a chip, ✕ removes it ─────────
  const allowlist = dialog.getByRole("list", {
    name: "Allowed preview sites",
  });
  await expect(
    allowlist.getByRole("listitem").filter({ hasText: "example.com" }),
  ).toHaveCount(0);
  await dialog.getByRole("button", { name: "Add" }).click();
  const exampleChip = allowlist
    .getByRole("listitem")
    .filter({ hasText: "example.com" });
  await expect(exampleChip).toBeVisible();
  // The add form clears for the next entry.
  await expect(hostField).toHaveValue("");
  // Remove it again — the chip disappears, leaving the defaults intact.
  await exampleChip.getByRole("button", { name: "Remove example.com" }).click();
  await expect(exampleChip).toHaveCount(0);
  await page.keyboard.press("Escape");

  // Toggling the pref off hides the lines — they are render-gated.
  await page.getByRole("button", { name: "Preferences" }).click();
  await dialog.getByRole("button", { name: "Appearance" }).click();
  await dialog.getByRole("switch", { name: "Show join/part/quit" }).click();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("presence-line")).toHaveCount(0);

  // ── Appearance: pick Moss Green, watch the theme repaint live ─────────
  expect(await appliedAccent(page)).not.toBe(MOSS);
  await page.getByRole("button", { name: "Preferences" }).click();
  await dialog.getByRole("button", { name: "Appearance" }).click();
  await dialog.getByRole("radio", { name: "Moss Green" }).click();
  await expect.poll(() => appliedAccent(page), { timeout: 5000 }).toBe(MOSS);

  // ── Light theme + colorblind mode (M9 step 5) ─────────────────────────
  await dialog.getByRole("radio", { name: "Parchment" }).click();
  await expect
    .poll(
      () =>
        page.evaluate(() =>
          getComputedStyle(document.documentElement)
            .getPropertyValue("--eb-bg")
            .trim(),
        ),
      { timeout: 5000 },
    )
    .toBe("#f6f1e7");
  await dialog
    .getByRole("switch", { name: "Colorblind-friendly status colors" })
    .click();
  await expect
    .poll(
      () =>
        page.evaluate(() =>
          document.documentElement.classList.contains("eb-colorblind"),
        ),
      { timeout: 5000 },
    )
    .toBe(true);
  // Back to the dark default for the rest of the spec.
  await dialog
    .getByRole("switch", { name: "Colorblind-friendly status colors" })
    .click();
  await dialog.getByRole("radio", { name: "Slate" }).click();

  // ── Interface font size (#319, #328): the pref must resize real chrome ──
  // Measure the *computed* font-size of a real chrome element (a Preferences
  // field label — prefs is in-scope chrome), not just the root style: #328 was
  // that the root font-size ramp never reached the px-based chrome. Do this
  // while scale is still 100% so `zoom` never perturbs the reading.
  const uiFontRadios = dialog.getByRole("radiogroup", {
    name: "Interface font size",
  });
  const chromeLabel = dialog.getByText("Interface font size", { exact: true });
  const chromeFontPx = () =>
    chromeLabel.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
  const baseFontPx = await chromeFontPx();
  // L → chrome type grows.
  await uiFontRadios.getByRole("radio", { name: "L" }).click();
  await expect
    .poll(chromeFontPx, { timeout: 5000 })
    .toBeGreaterThan(baseFontPx);
  // S → chrome type shrinks below the M baseline.
  await uiFontRadios.getByRole("radio", { name: "S" }).click();
  await expect.poll(chromeFontPx, { timeout: 5000 }).toBeLessThan(baseFontPx);
  // Back to M — exact original size restored.
  await uiFontRadios.getByRole("radio", { name: "M" }).click();
  await expect.poll(chromeFontPx, { timeout: 5000 }).toBe(baseFontPx);

  // ── Interface scale (#319): browser-zoom on :root ─────────────────────
  const rootZoom = () =>
    page.evaluate(() => document.documentElement.style.zoom);
  // Two +steps from 100% → 110% → 125% (zoom 1.25).
  const scaleControl = dialog.getByRole("group", { name: "Interface scale" });
  const scaleUp = dialog.getByRole("button", {
    name: "Increase Interface scale",
  });
  await scaleUp.click();
  await scaleUp.click();
  await expect(scaleControl.getByText("125%")).toBeVisible();
  await expect.poll(rootZoom, { timeout: 5000 }).toBe("1.25");
  // Reset to the default so the rest of the spec runs unscaled.
  await dialog
    .getByRole("button", { name: "Decrease Interface scale" })
    .click();
  await dialog
    .getByRole("button", { name: "Decrease Interface scale" })
    .click();
  await expect.poll(rootZoom, { timeout: 5000 }).toBe("1");

  await page.keyboard.press("Escape");

  // Survives a reload (flash cache + server prefs agree).
  await page.reload();
  await expect(page.getByText("Hazel Fenwick · online")).toBeVisible({
    timeout: 15_000,
  });
  expect(await appliedAccent(page)).toBe(MOSS);

  // ── A second device logs in fresh and paints Moss from the server ─────
  const contextB = await browser.newContext();
  try {
    const pageB = await contextB.newPage();
    await interceptAvatars(pageB);
    await pageB.goto("/login");
    await pageB.getByLabel("Email").fill(creds.email);
    await pageB.getByLabel("Password").fill(creds.password);
    await pageB.getByRole("button", { name: "Log in" }).click();
    await expect(pageB).toHaveURL(/\/identities$/);
    // The session is already live (device A connected it) → Open.
    await pageB.getByRole("button", { name: "Open", exact: true }).click();
    await expect(pageB).toHaveURL(/\/app\//);
    // The snapshot's prefs hydrate the theme — no local cache involved.
    await expect
      .poll(() => appliedAccent(pageB), { timeout: 10_000 })
      .toBe(MOSS);
  } finally {
    await contextB.close();
  }

  // ── Highlights (M5 step 6): rules CRUD, then mention badge + tint ─────
  await page.getByRole("button", { name: "Preferences" }).click();
  await dialog.getByRole("button", { name: "Highlights" }).click();
  await expect(
    dialog.getByText("No rules yet", { exact: false }),
  ).toBeVisible();

  // A regex RE2 refuses comes back as the PUT's 422, surfaced inline.
  await dialog.getByRole("radio", { name: "Regex" }).click();
  await dialog.getByLabel("Rule pattern").fill("glow(moss");
  await dialog.getByRole("button", { name: "Add" }).click();
  await expect(dialog.getByRole("alert")).toBeVisible();

  // A valid regex rule lands as a chip (the milestone verification rule).
  await dialog.getByLabel("Rule pattern").fill("glow(moss|cap)");
  await dialog.getByRole("button", { name: "Add" }).click();
  await expect(dialog.getByText("glow(moss|cap)")).toBeVisible();
  await page.keyboard.press("Escape");

  // Badges only bump for inactive conversations — step off Terrarium.
  await page.goto("/app/Hazel%20Fenwick");
  const terrariumRow = page.getByRole("link", { name: /Terrarium/ });
  await expect(terrariumRow).toBeVisible({ timeout: 15_000 });

  // The sibling character says the magic word. JCH→MSG on one socket is
  // ordered, so the membership exists by the time the message arrives.
  const sprout2 = await SimClient.connect(
    "hazel@example.test",
    "hunter2",
    "Fenwick Sprout",
  );
  try {
    sprout2.send("JCH", { channel: "Terrarium" });
    sprout2.send("MSG", {
      channel: "Terrarium",
      message: "the glowmoss is spreading again",
    });
    // The persist-time verdict rides message.new → the @-badge, not a
    // plain unread count.
    await expect(terrariumRow.getByTestId("nav-badge")).toHaveText("@1", {
      timeout: 10_000,
    });

    // Visiting shows the tinted row; the inset bar follows the accent
    // (Moss, chosen above) because highlightTint defaults to "accent".
    await terrariumRow.click();
    const mentionRow = page.locator("[data-mention]");
    await expect(mentionRow).toContainText("glowmoss");
    const shadow = await mentionRow.evaluate(
      (el) => getComputedStyle(el).boxShadow,
    );
    expect(shadow).toContain("rgb(136, 172, 114)");
  } finally {
    sprout2.close();
  }

  // ── Away & logs (M5 step 7): away prefs persist, log export downloads ─
  await page.getByRole("button", { name: "Preferences" }).click();
  await dialog.getByRole("button", { name: "Away & logs" }).click();
  // The log-location statement (developer-policy requirement).
  await expect(
    dialog.getByText("stored in the EmberChat server database", {
      exact: false,
    }),
  ).toBeVisible();

  await dialog.getByLabel("Away message").fill("Tending the moss");
  await dialog.getByLabel("Away message").press("Enter");
  await dialog.getByRole("switch", { name: "Away when idle" }).click();

  // Export the Terrarium log as .txt — the mention message is in it.
  await dialog
    .getByLabel("Conversation to export")
    .selectOption({ label: "# Terrarium" });
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    dialog.getByRole("button", { name: "Download" }).click(),
  ]);
  expect(download.suggestedFilename()).toBe("Terrarium.txt");
  const exportPath = await download.path();
  expect(readFileSync(exportPath, "utf8")).toContain(
    "Fenwick Sprout: the glowmoss is spreading again",
  );

  // Away prefs are server-side like everything else: a fresh pane mount
  // reads them back.
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Preferences" }).click();
  await dialog.getByRole("button", { name: "Away & logs" }).click();
  await expect(dialog.getByLabel("Away message")).toHaveValue(
    "Tending the moss",
  );
  await expect(
    dialog.getByRole("switch", { name: "Away when idle" }),
  ).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Escape");

  // ── Notifications (M5 step 8): permission flow, mention notify, mute ──
  // A recording Notification stub, installed before the next load: real OS
  // notifications are invisible to the test runner.
  await page.addInitScript(() => {
    const recorded: { title: string; body?: string }[] = [];
    class FakeNotification {
      static permission = "granted";
      static requestPermission = () => Promise.resolve("granted");
      onclick: (() => void) | null = null;
      constructor(title: string, options?: { body?: string }) {
        recorded.push({ title, ...options });
      }
      close() {}
    }
    // Headless pages report hasFocus() true even in the background — the
    // flag lets the test act out "the user is in another window".
    const realHasFocus = document.hasFocus.bind(document);
    document.hasFocus = () =>
      (window as unknown as { __pretendUnfocused?: boolean }).__pretendUnfocused
        ? false
        : realHasFocus();
    Object.assign(window, {
      Notification: FakeNotification,
      __notifications: recorded,
    });
  });
  await page.reload();
  await expect(page.getByText("Hazel Fenwick · online")).toBeVisible({
    timeout: 15_000,
  });
  const recordedCount = () =>
    page.evaluate(
      () =>
        (window as unknown as { __notifications: { title: string }[] })
          .__notifications.length,
    );

  await page.getByRole("button", { name: "Preferences" }).click();
  await dialog.getByRole("button", { name: "Notifications" }).click();
  await dialog.getByRole("switch", { name: "On mentions" }).click();
  await expect(
    dialog.getByRole("switch", { name: "On mentions" }),
  ).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Escape");

  // Notifications only fire while the tab is unfocused — flip the stubbed
  // focus signal, like the user switching to another window.
  await page.evaluate(() => {
    (window as unknown as { __pretendUnfocused?: boolean }).__pretendUnfocused =
      true;
  });
  const sprout3 = await SimClient.connect(
    "hazel@example.test",
    "hunter2",
    "Fenwick Sprout",
  );
  try {
    sprout3.send("JCH", { channel: "Terrarium" });
    sprout3.send("MSG", {
      channel: "Terrarium",
      message: "fresh glowmoss by the waterfall",
    });
    await expect.poll(recordedCount, { timeout: 10_000 }).toBe(1);
    expect(
      await page.evaluate(
        () =>
          (
            window as unknown as {
              __notifications: { title: string; body?: string }[];
            }
          ).__notifications[0],
      ),
    ).toMatchObject({
      title: "Fenwick Sprout — Terrarium",
      body: "fresh glowmoss by the waterfall",
    });

    // Mute Terrarium from its sidebar row's context menu (#234): alerts
    // stop, badges keep counting.
    const terrariumRow = page.getByRole("link", { name: /Terrarium/ });
    await terrariumRow.click({ button: "right" });
    const terrariumMenu = page.getByRole("menu", { name: "Terrarium menu" });
    await terrariumMenu
      .getByRole("menuitem", { name: "Mute", exact: true })
      .click();
    await terrariumRow.click({ button: "right" });
    await expect(
      terrariumMenu.getByRole("menuitem", { name: "Unmute", exact: true }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await page.goto("/app/Hazel%20Fenwick");
    const terrariumRow2 = page.getByRole("link", { name: /Terrarium/ });
    await expect(terrariumRow2).toBeVisible({ timeout: 15_000 });
    // The navigation re-ran the init script — pretend to be unfocused
    // again, so silence below is the mute's doing, not the focus gate's.
    await page.evaluate(() => {
      (
        window as unknown as { __pretendUnfocused?: boolean }
      ).__pretendUnfocused = true;
    });

    sprout3.send("MSG", {
      channel: "Terrarium",
      message: "glowmoss update: still glowing",
    });
    // The badge accrues (mute is alerts-only)…
    await expect(terrariumRow2.getByTestId("nav-badge")).toHaveText("@1", {
      timeout: 10_000,
    });
    // …but no notification arrived for the muted conversation (the
    // navigation reset the recorder, so any at all would be new).
    expect(await recordedCount()).toBe(0);

    // The pane lists the mute; unmuting clears it.
    await page.getByRole("button", { name: "Preferences" }).click();
    await dialog.getByRole("button", { name: "Notifications" }).click();
    await expect(dialog.getByText("# Terrarium")).toBeVisible();
    await dialog.getByRole("button", { name: "Unmute # Terrarium" }).click();
    await expect(
      dialog.getByText("Nothing muted", { exact: false }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
  } finally {
    sprout3.close();
  }
});
