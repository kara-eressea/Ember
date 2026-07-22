// The inline-rendering composer E2E (#226): the "Style formatting as you
// type" preference swaps the plain textarea for the CodeMirror input whose
// document is the markdown string. Verifies the contract points the rework
// moved: live decorations from the shared translator scanner, Enter-send vs
// Shift+Enter newline, the slash autocomplete keyboard flow reading live
// editor state (#235), toolbar marker wrapping and eicon insertion through
// the ComposerInputHandle shim, spoilers, the send timer + recall, paste as
// plain text, and undo of an external toolbar edit. Owns tansy@example.test
// (Tansy Meridian): spec files run in parallel, so specs never share
// accounts (a new ticket invalidates all previous ones account-wide).

import { expect, test } from "@playwright/test";
import {
  delay,
  interceptAvatars,
  joinChannel,
  provisionAndConnect,
} from "./helpers.js";

test("inline composer: decorations, send, slash, toolbar, timer, paste, undo", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await interceptAvatars(page);

  await provisionAndConnect(page, "tansy@example.test", "Tansy Meridian");

  // ── Opt in through Preferences (default is the classic textarea) ──────
  await page.getByRole("button", { name: "Preferences" }).click();
  const prefsDialog = page.getByRole("dialog", { name: "Preferences" });
  await prefsDialog
    .getByRole("switch", { name: "Style formatting as you type" })
    .click();
  await page.keyboard.press("Escape");
  await expect(prefsDialog).not.toBeVisible();

  await joinChannel(page, "Development", "Development");

  // exact: the sidebar's "Message a character" DM form would substring-match.
  const input = page.getByLabel("Message", { exact: true });
  const log = page.getByTestId("message-log");
  await expect(page.getByTestId("inline-composer")).toBeVisible();
  // The separate preview panel is gone in inline mode.
  await expect(page.getByTestId("md-preview")).toHaveCount(0);

  // ── Live decorations while typing ─────────────────────────────────────
  await input.click();
  await page.keyboard.type("**bold** and *slanted* and ||hidden|| stay");
  await expect(page.locator(".emb-b")).toHaveText("bold");
  await expect(page.locator(".emb-i")).toHaveText("slanted");
  await expect(page.locator(".emb-spoiler")).toHaveText("hidden");
  // Markers stay visible but dimmed — the text is still plain markdown.
  await expect(page.locator(".emb-delim").first()).toBeVisible();
  await expect(page.getByTestId("md-preview")).toHaveCount(0);

  // ── Enter sends the markdown→BBCode wire form ─────────────────────────
  await page.keyboard.press("Enter");
  await expect(log.getByText("bold", { exact: true })).toBeVisible({
    timeout: 10_000,
  });
  await expect(log).not.toContainText("**bold**");
  await expect(input.locator(".cm-placeholder")).toBeVisible();

  // ── Shift+Enter breaks the line, nothing sends ────────────────────────
  await page.keyboard.type("line one");
  await page.keyboard.press("Shift+Enter");
  await page.keyboard.type("line two");
  await expect(input).toContainText("line one");
  await expect(input).toContainText("line two");
  await expect(log).not.toContainText("line one", { timeout: 1000 });
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.press("Delete");
  await expect(input.locator(".cm-placeholder")).toBeVisible();

  // ── Slash autocomplete from live editor state (#235) ──────────────────
  await page.keyboard.type("/rol");
  const slash = page.getByTestId("slash-autocomplete");
  await expect(slash).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(input).toHaveText(/^\/roll /);
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.press("Delete");
  // A fully-typed command runs on the first Enter (#235 contract).
  await page.keyboard.type("/help");
  await page.keyboard.press("Enter");
  const help = page.getByRole("dialog", { name: "Help" });
  await expect(help).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(help).not.toBeVisible();
  await expect(input.locator(".cm-placeholder")).toBeVisible();

  // ── Toolbar marker-pair wrap through the handle shim ──────────────────
  await input.click();
  await page.keyboard.type("glow");
  await page.keyboard.press("ControlOrMeta+a");
  await page.getByRole("button", { name: "Bold", exact: true }).click();
  await expect(input).toHaveText(/\*\*glow\*\*/);
  await expect(page.locator(".emb-b")).toHaveText("glow");

  // ── Undo reverts the toolbar edit (CodeMirror history) ────────────────
  await page.keyboard.press("ControlOrMeta+z");
  await expect(input).toHaveText("glow");
  await expect(page.locator(".emb-b")).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.press("Delete");

  // ── Typed eicon: chip while touched, real image once the caret leaves ─
  await page.keyboard.type("hi [eicon]lickinglips[/eicon]");
  // Caret sits at the closer, so the editable text shows, chip-styled.
  await expect(page.locator(".emb-eicon")).toHaveText(
    "[eicon]lickinglips[/eicon]",
  );
  await page.keyboard.type(" tail");
  // Caret moved past — the atom renders as the actual eicon image.
  await expect(
    input.getByRole("img", { name: "[eicon]lickinglips[/eicon]" }),
  ).toBeVisible();
  // Sending it records the eicon into Recents (and clears the editor).
  await page.keyboard.press("Enter");
  await expect(log.getByRole("img", { name: "lickinglips" })).toBeVisible({
    timeout: 10_000,
  });

  // ── Picker insertion lands at the caret, not the end ──────────────────
  await page.keyboard.type("XY");
  await page.keyboard.press("ArrowLeft");
  await page.getByRole("button", { name: "Eicon", exact: true }).click();
  const picker = page.getByRole("dialog", { name: "Eicon picker" });
  await expect(picker).toBeVisible();
  await picker.getByRole("tab", { name: "Recents" }).click();
  await picker.getByRole("button", { name: "Insert lickinglips" }).click();
  await page.keyboard.press("Escape");
  await expect(picker).not.toBeVisible();
  await expect(input).toHaveText("X[eicon]lickinglips[/eicon]Y");
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.press("Delete");

  // ── Paste is plain text: the markdown string, never rich HTML ─────────
  await input.click();
  await input.evaluate((el) => {
    const data = new DataTransfer();
    data.setData("text/html", "<b>rich</b> markup");
    data.setData("text/plain", "**pasted** plain");
    el.dispatchEvent(
      new ClipboardEvent("paste", {
        clipboardData: data,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  await expect(input).toHaveText("**pasted** plain");
  await expect(page.locator(".emb-b")).toHaveText("pasted");
  await expect(input).not.toContainText("rich");
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.press("Delete");

  // ── Send timer: pending chip + ArrowUp recall into the editor ─────────
  const timer = page.getByRole("button", { name: "Send timer" });
  await timer.click();
  await page.getByRole("radio", { name: "15 seconds" }).click();
  await expect(timer).toHaveAttribute("aria-pressed", "true");
  await input.click();
  await page.keyboard.type("**recalled** never arrives");
  await page.keyboard.press("Enter");
  const pending = page.getByTestId("pending-send");
  await expect(pending).toBeVisible();
  // ArrowUp in the empty composer pulls it back — as typed, not as BBCode.
  await page.keyboard.press("ArrowUp");
  await expect(input).toContainText("**recalled** never arrives", {
    timeout: 10_000,
  });
  await expect(page.locator(".emb-b")).toHaveText("recalled");
  await expect(page.getByTestId("pending-send")).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.press("Delete");
  await timer.click();
  await page.getByRole("radio", { name: "Off (send instantly)" }).click();
  await delay(100);

  // ── Flipping the preference back restores the classic textarea ────────
  await page.getByRole("button", { name: "Preferences" }).click();
  await prefsDialog
    .getByRole("switch", { name: "Style formatting as you type" })
    .click();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("inline-composer")).toHaveCount(0);
  await expect(page.getByLabel("Message", { exact: true })).toBeVisible();
});
