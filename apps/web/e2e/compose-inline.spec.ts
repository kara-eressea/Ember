// SPIKE (#226): the inline-rendering CodeMirror composer behind the
// emberchat.inlineComposer flag. Verifies the riskiest contract points:
// live decorations while typing, Enter-send vs Shift+Enter newline, the
// slash autocomplete keyboard flow reading live editor state, and toolbar
// marker-pair wrapping through the ComposerInputHandle shim.
// SPIKE ONLY: borrows sage@example.test (compose.spec's account) — run this
// spec solo, never alongside the suite; a real landing adds its own sim
// account (every sim account is spoken for by a parallel spec).

import { expect, test } from "@playwright/test";
import {
  interceptAvatars,
  joinChannel,
  provisionAndConnect,
} from "./helpers.js";

test("inline composer: decorations, send, slash, toolbar wrap", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await interceptAvatars(page);
  await page.addInitScript(() => {
    localStorage.setItem("emberchat.inlineComposer", "on");
  });

  await provisionAndConnect(page, "sage@example.test", "Sage Willowmere");
  await joinChannel(page, "Development", "Development");

  const input = page.getByLabel("Message", { exact: true });
  const log = page.getByTestId("message-log");
  await expect(page.getByTestId("inline-composer")).toBeVisible();
  // The separate preview panel is gone in inline mode.
  await expect(page.getByTestId("md-preview")).toHaveCount(0);

  // ── Live decorations while typing ─────────────────────────────────────
  await input.click();
  await page.keyboard.type("**bold** and *slanted* stay");
  const boldMark = page.locator(".emb-b");
  await expect(boldMark).toHaveText("bold");
  await expect(page.locator(".emb-i")).toHaveText("slanted");
  // Markers stay visible but dimmed — the text is still plain markdown.
  await expect(page.locator(".emb-delim").first()).toBeVisible();

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

  // ── Slash autocomplete from live editor state ─────────────────────────
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
  // Ctrl+B wraps too (empty selection at caret end → empty pair).
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.press("Delete");

  // ── Typed eicon renders as a chip-styled atom ─────────────────────────
  await page.keyboard.type("hi [eicon]lickinglips[/eicon]");
  await expect(page.locator(".emb-eicon")).toHaveText(
    "[eicon]lickinglips[/eicon]",
  );
});
