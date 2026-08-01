// #407: a newly attached browser must not stop the fan-out to browsers that
// were already attached. Device A sits in a channel; device B logs into the
// same app account and opens the same identity; A must keep painting live
// messages. Owns cedar@example.test (Cedar Vale) and
// bark@example.test (Bark Wren).

import {
  expect,
  interceptAvatars,
  joinChannel,
  provisionAndConnect,
  SimClient,
  test,
} from "./helpers.js";

test("a second browser attaching leaves the first still receiving live messages", async ({
  page,
  browser,
}) => {
  test.setTimeout(180_000);
  await interceptAvatars(page);

  const creds = await provisionAndConnect(
    page,
    "cedar@example.test",
    "Cedar Vale",
  );
  await joinChannel(page, "Development", "Development");

  const bark = await SimClient.connect(
    "bark@example.test",
    "hunter2",
    "Bark Wren",
  );
  try {
    bark.send("JCH", { channel: "Development" });
    bark.send("MSG", { channel: "Development", message: "before B" });
    await expect(
      page.getByTestId("message-log").getByText("before B"),
    ).toBeVisible();

    // ── Device B: a second browser context attaches to the same identity ─
    const contextB = await browser.newContext();
    const pageB = await contextB.newPage();
    await interceptAvatars(pageB);
    await pageB.goto("/login");
    await pageB.getByLabel("Email").fill(creds.email);
    await pageB.getByLabel("Password").fill(creds.password);
    await pageB.getByRole("button", { name: "Log in" }).click();
    await expect(pageB).toHaveURL(/\/identities$/);
    await pageB.getByRole("button", { name: "Open", exact: true }).click();
    await expect(pageB).toHaveURL(/\/app\//);
    await expect(
      pageB.getByRole("navigation").getByRole("link", { name: /Development/ }),
    ).toBeVisible();

    // ── The first browser must still receive live channel traffic ────────
    bark.send("MSG", { channel: "Development", message: "after B" });
    await expect(
      page.getByTestId("message-log").getByText("after B"),
    ).toBeVisible({ timeout: 15_000 });

    // ── What the second device does must reach the first, and vice versa ──
    await pageB
      .getByRole("navigation")
      .getByRole("link", { name: /Development/ })
      .click();
    await expect(
      pageB.getByRole("heading", { name: "Development" }),
    ).toBeVisible();
    await pageB.getByRole("textbox", { name: /message/i }).fill("typed on B");
    await pageB.keyboard.press("Enter");
    await expect(
      page.getByTestId("message-log").getByText("typed on B"),
    ).toBeVisible({ timeout: 15_000 });

    await page.getByRole("textbox", { name: /message/i }).fill("typed on A");
    await page.keyboard.press("Enter");
    await expect(
      pageB.getByTestId("message-log").getByText("typed on A"),
    ).toBeVisible({ timeout: 15_000 });

    bark.send("MSG", { channel: "Development", message: "last word" });
    await expect(
      page.getByTestId("message-log").getByText("last word"),
    ).toBeVisible({ timeout: 15_000 });
    await expect(
      pageB.getByTestId("message-log").getByText("last word"),
    ).toBeVisible({ timeout: 15_000 });

    await contextB.close();
  } finally {
    bark.close();
  }
});
