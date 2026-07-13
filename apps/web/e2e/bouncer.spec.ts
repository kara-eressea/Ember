// The M2 verification E2E (milestone-2.md): two devices on one app account —
// unread badges converge through the gateway fan-out, and the second device
// gets the "new since last visit" divider at catch-up. Owns
// willow@example.test (Willow Reed + Fern Ashwood): spec files run in
// parallel and a character can hold only one sim connection, so specs never
// share characters.

import { expect, test } from "@playwright/test";
import { SimClient, credentials, interceptAvatars } from "./helpers.js";

test("two devices: unread badges converge; catch-up shows the new divider", async ({
  page,
  browser,
}) => {
  test.setTimeout(180_000);
  await interceptAvatars(page);
  const creds = credentials();

  // ── Device A: register → Willow Reed → connect → sit in a channel ─────
  await page.goto("/register");
  await page.getByLabel("Username").fill(creds.username);
  await page.getByLabel("Email").fill(creds.email);
  await page.getByLabel("Password").fill(creds.password);
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Create account" }).click();
  await page.getByRole("button", { name: "Add a server identity" }).click();
  await page.getByLabel("F-List account name").fill("willow@example.test");
  await page.getByLabel("F-List password").fill("hunter2");
  await page.getByRole("button", { name: "Verify account" }).click();
  await page.getByRole("listitem").filter({ hasText: "Willow Reed" }).click();
  await page.getByRole("button", { name: "Connect" }).click();
  await expect(page).toHaveURL(/\/app\//);
  await expect(page.getByText("Willow Reed · online")).toBeVisible({
    timeout: 15_000,
  });
  await page.getByLabel("Join a channel").fill("Development");
  await page.getByRole("button", { name: "Join", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Development" })).toBeVisible({
    timeout: 10_000,
  });

  const fern = await SimClient.connect(
    "willow@example.test",
    "hunter2",
    "Fern Ashwood",
  );
  try {
    // A PM lands while device A watches the channel: sidebar badge appears.
    fern.send("PRI", { recipient: "Willow Reed", message: "first wave" });
    const navA = page.getByRole("navigation");
    const dmRowA = navA.getByRole("link", { name: /Fern Ashwood/ });
    await expect(dmRowA).toContainText("1");

    // ── Device B: a second browser context logs into the same account ───
    const contextB = await browser.newContext();
    const pageB = await contextB.newPage();
    await interceptAvatars(pageB);
    await pageB.goto("/login");
    await pageB.getByLabel("Email").fill(creds.email);
    await pageB.getByLabel("Password").fill(creds.password);
    await pageB.getByRole("button", { name: "Log in" }).click();
    await expect(pageB).toHaveURL(/\/identities$/);
    await pageB.getByRole("button", { name: "Connect" }).click();
    await expect(pageB).toHaveURL(/\/app\//);
    const navB = pageB.getByRole("navigation");
    const dmRowB = navB.getByRole("link", { name: /Fern Ashwood/ });
    // The unread count was computed server-side into B's snapshot.
    await expect(dmRowB).toContainText("1");

    // ── B reads the DM → the ack converges badges on BOTH devices ───────
    await dmRowB.click();
    await expect(
      pageB.getByTestId("message-log").getByText("first wave"),
    ).toBeVisible();
    await expect(dmRowB).not.toContainText("1");
    await expect(dmRowA).not.toContainText("1");

    // ── Second wave while B is elsewhere: badges return on both, and the
    //    reopened DM shows the "new" divider above the unread message ─────
    await navB.getByRole("link", { name: /Development/ }).click();
    await expect(
      pageB.getByRole("heading", { name: "Development" }),
    ).toBeVisible();
    fern.send("PRI", { recipient: "Willow Reed", message: "second wave" });
    await expect(dmRowB).toContainText("1");
    await expect(dmRowA).toContainText("1");

    await dmRowB.click();
    await expect(
      pageB.getByTestId("message-log").getByText("second wave"),
    ).toBeVisible();
    await expect(pageB.getByTestId("new-divider")).toBeVisible();
    // B's read converges A's badge away again.
    await expect(dmRowA).not.toContainText("1");

    await contextB.close();
  } finally {
    fern.close();
  }
});
