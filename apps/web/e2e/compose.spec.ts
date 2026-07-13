// The M4 verification E2E (milestone-4.md): Markdown preview matches the
// final render, eicons render inline at a fixed size, a delayed send can be
// recalled with ArrowUp, and a reload mid-delay doesn't lose the message
// (the outbox lives server-side). Owns sage@example.test (Sage Willowmere):
// spec files run in parallel, so specs never share characters. Development
// is shared but never member-counted (only chat.spec counts, on Frontpage).

import { expect, test } from "@playwright/test";
import { interceptAvatars, registerAndConnect } from "./helpers.js";

test("markdown compose: preview = render, eicons, delayed send + recall", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await interceptAvatars(page);

  await registerAndConnect(page, "sage@example.test", "Sage Willowmere");
  await page.getByLabel("Join a channel").fill("Development");
  await page.getByRole("button", { name: "Join", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Development" })).toBeVisible({
    timeout: 10_000,
  });

  // exact: the sidebar's "Message a character" DM form would substring-match.
  const input = page.getByLabel("Message", { exact: true });
  const log = page.getByTestId("message-log");

  // ── Preview matches the final render ──────────────────────────────────
  await input.fill("**bold words** and `a code span`");
  const preview = page.getByTestId("md-preview");
  await expect(preview).toBeVisible();
  // The preview renders the translated wire form through the same pipeline
  // as the log: real styling, no literal markers.
  await expect(preview.getByText("bold words", { exact: true })).toBeVisible();
  await expect(preview.getByText("a code span")).toBeVisible();
  await expect(preview).not.toContainText("**");
  await input.press("Enter");
  await expect(log.getByText("bold words", { exact: true })).toBeVisible({
    timeout: 10_000,
  });
  await expect(log.getByText("a code span")).toBeVisible();
  await expect(log).not.toContainText("**bold words**");

  // ── Eicons render inline at a fixed 60px box ───────────────────────────
  await input.fill("look: [eicon]teacup[/eicon]");
  await input.press("Enter");
  const eicon = log.getByRole("img", { name: "teacup" });
  await expect(eicon).toBeVisible({ timeout: 10_000 });
  await expect(eicon).toHaveAttribute("width", "60");
  await expect(eicon).toHaveAttribute("height", "60");

  // ── Delayed send: pending affordance + ArrowUp recall ─────────────────
  await page.getByLabel("Send delay").selectOption("10");
  await input.fill("**recalled** never arrives");
  await input.press("Enter");
  const pending = page.getByTestId("pending-send");
  await expect(pending).toBeVisible();
  await expect(pending).toContainText("sending in");
  // ArrowUp in the empty composer pulls it back — as typed, not as BBCode.
  await input.press("ArrowUp");
  await expect(input).toHaveValue("**recalled** never arrives", {
    timeout: 10_000,
  });
  await expect(page.getByTestId("pending-send")).toHaveCount(0);

  // ── Reload mid-delay: the outbox lives server-side ─────────────────────
  await input.fill("survives the reload");
  await input.press("Enter");
  await expect(page.getByTestId("pending-send")).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: "Development" })).toBeVisible({
    timeout: 15_000,
  });
  // The message releases ~10s after the send and lands as a real row.
  await expect(log.getByText("survives the reload")).toBeVisible({
    timeout: 20_000,
  });
  // The recalled message never made it out.
  await expect(log.getByText("recalled")).toHaveCount(0);
});
