// The #346 identity-rail-toggle E2E: clicking your own avatar (the MeBar,
// bottom-left) hides the identity rail, the choice survives a reload (per-
// device localStorage, like the #303 resizable columns), and connecting a
// second identity forces the hidden rail back into view so a newly-connected
// character is never lost. Owns tamarisk@example.test (Tamarisk Ash + Marsh
// Willow) and the Trellis Shed channel — spec files run in parallel and a
// character holds one sim connection, so specs share neither.
//
// #351 regression guard: hiding the rail must ONLY collapse the rail track —
// the shell's other columns (sidebar, chat, member list) must keep their own
// tracks. The original fix `display: none`d the rail, dropping it out of the
// grid so every later child shifted one track left (chat squashed into the
// sidebar-width track, members ballooning into 1fr). These assertions measure
// the real column geometry, not just that the rail vanished.

import { expect, test, type Locator } from "@playwright/test";
import {
  interceptAvatars,
  joinChannel,
  provisionAndConnect,
} from "./helpers.js";

async function width(locator: Locator): Promise<number> {
  const box = await locator.boundingBox();
  if (box === null) {
    throw new Error("element has no bounding box");
  }
  return box.width;
}

async function box(locator: Locator) {
  const b = await locator.boundingBox();
  if (b === null) {
    throw new Error("element has no bounding box");
  }
  return b;
}

test("identity rail: avatar toggle hides it without breaking the shell grid, survives a reload, a second identity un-hides it", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await interceptAvatars(page);

  await provisionAndConnect(page, "tamarisk@example.test", "Tamarisk Ash");
  // A channel with a member list, so all three content columns are live and
  // the grid track→area mapping is fully exercised.
  await joinChannel(page, "ADH-351railshed99aa88bb77", "Trellis Shed");

  const rail = page.getByRole("navigation", { name: "Identities" });
  const sidebar = page
    .getByRole("navigation")
    .filter({ has: page.getByLabel("Filter the channel list") });
  const chat = page.getByRole("main");
  const members = page.getByRole("complementary", { name: "Members" });
  const composer = page.getByRole("textbox", { name: /Message/ });
  const hide = page.getByRole("button", { name: "Hide identity rail" });
  const show = page.getByRole("button", { name: "Show identity rail" });

  await expect(members).toBeVisible();
  await expect(composer).toBeVisible();

  // With a single identity the rail is visible and the avatar offers to hide.
  await expect(rail).toBeVisible();
  await expect(hide).toBeVisible();
  await expect(hide).toHaveAttribute("aria-pressed", "false");

  // ── Click the avatar → the rail collapses, and ONLY the rail ──────────
  await hide.click();
  await expect(rail).toBeHidden();
  await expect(show).toBeVisible();
  await expect(show).toHaveAttribute("aria-pressed", "true");

  // The shell grid survives: each content column keeps its own track.
  await assertShellLayout();

  // The #303 resize handle still tracks the sidebar edge with the rail hidden:
  // dragging the "Resize sidebar" handle to an absolute X lands the sidebar at
  // that width (rail track is now 0, so the sidebar starts at x=0). The old
  // hardcoded 60px rail offset in the drag math would land it 60px short.
  const resizeHandle = page.getByRole("separator", { name: "Resize sidebar" });
  const handleBox = await box(resizeHandle);
  const targetX = 322;
  await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + 120);
  await page.mouse.down();
  await page.mouse.move(targetX, handleBox.y + 120, { steps: 8 });
  await page.mouse.up();
  await expect
    .poll(async () => Math.round(await width(sidebar)))
    .toBeGreaterThanOrEqual(targetX - 6);
  expect(await width(sidebar)).toBeLessThanOrEqual(targetX + 6);
  // Chat stays sane at the new sidebar width, and the columns still hold.
  await assertShellLayout();
  // Reset to the design-system default so the reload leg starts clean.
  await resizeHandle.dblclick();

  // The undo control stays reachable while hidden: the avatar is still in the
  // (full-width) sidebar, visible and clickable, and un-hides the rail.
  await expect(show).toBeVisible();
  await expect(show).toBeEnabled();
  await show.click();
  await expect(rail).toBeVisible();
  await expect(hide).toBeVisible();
  // Re-hide for the reload leg.
  await hide.click();
  await expect(rail).toBeHidden();

  // ── Reload → the choice is remembered, no flash, layout still intact ──
  await page.reload();
  await expect(show).toBeVisible({ timeout: 15_000 });
  await expect(show).toHaveAttribute("aria-pressed", "true");
  await expect(rail).toBeHidden();
  // Land back in the channel so the member column is live, then re-check.
  await page.getByRole("link", { name: /Trellis Shed/ }).click();
  await expect(members).toBeVisible();
  await assertShellLayout();

  // ── Connect a second identity → the hidden rail is forced back visible.
  //    The rail's own "+" is hidden with it, so reach the manager directly.
  await page.goto("/identities");
  await page.getByRole("button", { name: "Add a server identity" }).click();
  await page.getByRole("listitem").filter({ hasText: "Marsh Willow" }).click();
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.getByText("Marsh Willow · online")).toBeVisible({
    timeout: 15_000,
  });

  await expect(rail).toBeVisible();
  await expect(rail.getByTestId("rail-item")).toHaveCount(2);
  // The label tracks the effective visibility: forced visible, it reads
  // "Hide" again — while the stored preference stays hidden underneath, ready
  // to take effect the moment the second identity drops away.
  await expect(hide).toBeVisible();

  // Assert the shell columns hold their tracks: sidebar first, chat widest in
  // the middle, member list in its own right-hand track — never the collapse
  // that shifted chat into the sidebar's width and members into 1fr.
  async function assertShellLayout() {
    const sidebarBox = await box(sidebar);
    const chatBox = await box(chat);
    const membersW = await width(members);

    // The sidebar sits at the left edge (rail track collapsed to 0) at a width
    // inside the #303 resizable bounds — not squashed to a sliver.
    expect(sidebarBox.x).toBeLessThan(4);
    expect(sidebarBox.width).toBeGreaterThanOrEqual(180);
    expect(sidebarBox.width).toBeLessThanOrEqual(400);

    // Chat begins right after the sidebar and takes the flexible middle track:
    // far wider than either docked column, never crushed into the 244px slot.
    expect(chatBox.x).toBeGreaterThanOrEqual(sidebarBox.width - 4);
    expect(chatBox.x).toBeLessThanOrEqual(sidebarBox.width + 4);
    expect(chatBox.width).toBeGreaterThan(500);
    expect(chatBox.width).toBeGreaterThan(sidebarBox.width);
    expect(chatBox.width).toBeGreaterThan(membersW);

    // The member list keeps its own right-hand track (~232px, docked bounds),
    // to the right of chat — not ballooned into the flexible 1fr track.
    expect(membersW).toBeLessThanOrEqual(400);
    const membersBox = await box(members);
    expect(membersBox.x).toBeGreaterThanOrEqual(chatBox.x + chatBox.width - 4);

    // The composer stays usable — a full-width input, not a crushed sliver.
    expect(await width(composer)).toBeGreaterThan(400);
  }
});
