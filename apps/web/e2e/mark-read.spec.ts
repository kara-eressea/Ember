// "Mark as read" from the sidebar context menus (#315): a backlog can be
// cleared without opening the conversation. The sidebar right-click menus gain
// a Mark as read item that clears the unread badge and advances the persisted
// read cursor — so it does not navigate and it sticks across a reattach. Owns
// bracken@example.test (Bracken Vale + Cress Dell): spec files run in parallel
// and a character holds only one sim connection, so specs never share one.

import { expect, test } from "@playwright/test";
import { SimClient, interceptAvatars, provisionAndConnect } from "./helpers.js";

test("mark a DM read from its row menu — badge clears, no navigation, survives reattach", async ({
  page,
}) => {
  test.setTimeout(60_000);
  await interceptAvatars(page);

  await provisionAndConnect(page, "bracken@example.test", "Bracken Vale");

  const cress = await SimClient.connect(
    "bracken@example.test",
    "hunter2",
    "Cress Dell",
  );
  try {
    // An unread DM lands in the sidebar; the conversation is never opened.
    cress.send("PRI", { recipient: "Bracken Vale", message: "psst, awake?" });
    const nav = page.getByRole("navigation");
    const dmRow = nav.getByRole("link", { name: /Cress Dell/ });
    await expect(dmRow.getByTestId("nav-badge")).toBeVisible({
      timeout: 15_000,
    });

    // Right-click the row and mark it read: the badge clears and the route
    // must not change to the conversation.
    const urlBefore = page.url();
    await dmRow.click({ button: "right" });
    const menu = page.getByRole("menu", { name: "Cress Dell menu" });
    await menu.getByRole("menuitem", { name: "Mark as read" }).click();

    await expect(dmRow.getByTestId("nav-badge")).toHaveCount(0);
    expect(page.url()).toBe(urlBefore);

    // It sticks: a full detach + reattach shows no backlog badge — the read
    // cursor advanced server-side, not just the local badge.
    await page.goto("/identities");
    await page.getByRole("button", { name: "Open", exact: true }).click();
    await expect(page).toHaveURL(/\/app\//);
    await expect(
      nav.getByRole("link", { name: /Cress Dell/ }).getByTestId("nav-badge"),
    ).toHaveCount(0);
  } finally {
    cress.close();
  }
});
