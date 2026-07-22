// Sidebar offline filtering (#329): offline hiding now covers DM rows, with
// three always-show exemptions (pinned, unread, currently open), and each
// people section carries its own "show offline" toggle reached by
// right-clicking its header. Two cases:
//
//   1. Header toggle — an offline, read DM row hides by default; the Direct
//      messages header's "Show offline" reveals it and hides it again.
//   2. Reattach + unread — the critical case: an offline partner's read DM
//      row is hidden, messages pile up while the browser is detached, and
//      the reattached client shows the row again (unread exemption) even
//      though the partner is still offline.
//
// Owns sorrel@example.test (Sorrel Ash + Dusk Wren) and bramble@example.test
// (Bramble Fen + Moss Dell): spec files run in parallel and a character holds
// only one sim connection, so specs never share characters.

import { expect, test } from "@playwright/test";
import {
  SimClient,
  delay,
  interceptAvatars,
  provisionAndConnect,
} from "./helpers.js";

test("offline DM row hides when read, and the header toggle shows it", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await interceptAvatars(page);
  await provisionAndConnect(page, "sorrel@example.test", "Sorrel Ash");

  const nav = page.getByRole("navigation");
  const dusk = await SimClient.connect(
    "sorrel@example.test",
    "hunter2",
    "Dusk Wren",
  );
  try {
    // Dusk (online) opens a DM; read it so no unread exemption applies.
    dusk.send("PRI", { recipient: "Sorrel Ash", message: "hey there" });
    const dmRow = nav.getByRole("link", { name: /Dusk Wren/ });
    await dmRow.click();
    await expect(
      page.getByTestId("message-log").getByText("hey there"),
    ).toBeVisible({ timeout: 15_000 });

    // Leave the conversation so the "currently open" exemption stops holding
    // the row, then take Dusk offline (FLN). Offline + read + unpinned +
    // unopened → the row hides.
    await page.goto("/app/Sorrel%20Ash");
    dusk.close();
    await expect(dmRow).toHaveCount(0, { timeout: 15_000 });

    // Right-click the Direct messages header → "Show offline" reveals it.
    await nav.getByText("Direct messages", { exact: true }).click({
      button: "right",
    });
    const menu = page.getByRole("menu", {
      name: "Direct messages section menu",
    });
    await menu.getByRole("menuitemcheckbox", { name: "Show offline" }).click();
    await expect(dmRow).toBeVisible({ timeout: 15_000 });

    // Toggling it back off hides the offline, read row again.
    await nav.getByText("Direct messages", { exact: true }).click({
      button: "right",
    });
    await page
      .getByRole("menu", { name: "Direct messages section menu" })
      .getByRole("menuitemcheckbox", { name: "Show offline" })
      .click();
    await expect(dmRow).toHaveCount(0, { timeout: 15_000 });
  } finally {
    dusk.close();
  }
});

test("reattach shows a hidden offline DM row once unread arrives while detached", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await interceptAvatars(page);
  await provisionAndConnect(page, "bramble@example.test", "Bramble Fen");

  const nav = page.getByRole("navigation");
  const dmRow = nav.getByRole("link", { name: /Moss Dell/ });

  let moss = await SimClient.connect(
    "bramble@example.test",
    "hunter2",
    "Moss Dell",
  );
  try {
    // A first DM, read while attached — the row exists and has no unread.
    moss.send("PRI", { recipient: "Bramble Fen", message: "first hello" });
    await dmRow.click();
    await expect(
      page.getByTestId("message-log").getByText("first hello"),
    ).toBeVisible({ timeout: 15_000 });

    // Leave the conversation and take Moss offline: read + offline + unpinned
    // + unopened → the row hides.
    await page.goto("/app/Bramble%20Fen");
    moss.close();
    await expect(dmRow).toHaveCount(0, { timeout: 15_000 });

    // ── Detach: the bouncer holds the session and keeps accruing state ────
    await page.goto("about:blank");
    moss = await SimClient.connect(
      "bramble@example.test",
      "hunter2",
      "Moss Dell",
    );
    for (let i = 1; i <= 3; i += 1) {
      moss.send("PRI", {
        recipient: "Bramble Fen",
        message: `while away #${String(i)}`,
      });
      await delay(80);
    }
    // Moss goes offline again — so at reattach the partner is still offline
    // and only the unread exemption can keep the row on screen.
    moss.close();
    await delay(200);

    // ── Reattach: the snapshot carries the offline partner with unread ────
    await page.goto("/identities");
    await page.getByRole("button", { name: "Open", exact: true }).click();
    await expect(page).toHaveURL(/\/app\//);

    // The row is back — hidden by presence, kept by the unread exemption —
    // and carries the unread badge.
    await expect(dmRow).toBeVisible({ timeout: 15_000 });
    await expect(dmRow.getByTestId("nav-badge")).toBeVisible();
  } finally {
    moss.close();
  }
});
