// The M2 verification E2E (milestone-2.md): two devices on one app account —
// unread badges converge through the gateway fan-out, and the second device
// gets the "new since last visit" divider at catch-up. Owns
// willow@example.test (Willow Reed + Fern Ashwood): spec files run in
// parallel and a character can hold only one sim connection, so specs never
// share characters.

import { expect, test } from "@playwright/test";
import { SimClient, interceptAvatars, registerAndConnect } from "./helpers.js";

test("two devices: unread badges converge; catch-up shows the new divider", async ({
  page,
  browser,
}) => {
  test.setTimeout(180_000);
  await interceptAvatars(page);

  // ── Device A: register → Willow Reed → connect → sit in a channel ─────
  const creds = await registerAndConnect(
    page,
    "willow@example.test",
    "Willow Reed",
  );
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
    const badgeA = dmRowA.getByTestId("nav-badge");
    await expect(badgeA).toHaveText("1");

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
    const badgeB = dmRowB.getByTestId("nav-badge");
    // The unread count was computed server-side into B's snapshot.
    await expect(badgeB).toHaveText("1");

    // ── B reads the DM → the ack converges badges on BOTH devices ───────
    await dmRowB.click();
    await expect(
      pageB.getByTestId("message-log").getByText("first wave"),
    ).toBeVisible();
    await expect(badgeB).toHaveCount(0);
    await expect(badgeA).toHaveCount(0);

    // ── Second wave while B is elsewhere: badges return on both, and the
    //    reopened DM shows the "new" divider above the unread message ─────
    await navB.getByRole("link", { name: /Development/ }).click();
    await expect(
      pageB.getByRole("heading", { name: "Development" }),
    ).toBeVisible();
    fern.send("PRI", { recipient: "Willow Reed", message: "second wave" });
    await expect(badgeB).toHaveText("1");
    await expect(badgeA).toHaveText("1");

    await dmRowB.click();
    await expect(
      pageB.getByTestId("message-log").getByText("second wave"),
    ).toBeVisible();
    await expect(pageB.getByTestId("new-divider")).toBeVisible();
    // B's read converges A's badge away again.
    await expect(badgeA).toHaveCount(0);

    await contextB.close();
  } finally {
    fern.close();
  }
});
