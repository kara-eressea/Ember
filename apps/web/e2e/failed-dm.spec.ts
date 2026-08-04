// The #491 verification E2E: a DM sent to someone who just went offline is
// marked in the log with its cause instead of sitting there looking sent, and
// the retry it offers goes through once the partner is back — re-sending the
// same line rather than stacking a second one. Owns corvin@example.test
// (Corvin Ash) and slateharrow@example.test (Slate Harrow, the raw-SimClient
// "other side") — spec files run in parallel, so specs never share characters.

import {
  expect,
  interceptAvatars,
  provisionAndConnect,
  SimClient,
  test,
} from "./helpers.js";

const MESSAGE = "did you get the trellis?";

test("failed DM: marked with its cause, retried when the partner returns", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await interceptAvatars(page);

  await provisionAndConnect(page, "corvin@example.test", "Corvin Ash");

  // Slate opens the conversation with an inbound PM, then logs off — the
  // shape of the bug: the DM is open, the partner is gone.
  const slate = await SimClient.connect(
    "slateharrow@example.test",
    "hunter2",
    "Slate Harrow",
  );
  slate.send("PRI", {
    recipient: "Corvin Ash",
    message: "Back in a moment.",
  });

  const nav = page.getByRole("navigation");
  await nav.getByRole("link", { name: /Slate Harrow/ }).click();
  await expect(page).toHaveURL(/\/dm\/Slate%20Harrow$/);
  const log = page.getByTestId("message-log");
  await expect(log.getByText("Back in a moment.")).toBeVisible({
    timeout: 10_000,
  });

  // She logs off. The row stays in the sidebar while her conversation is
  // open (the offline filter's "currently open" exemption), which is exactly
  // the situation the issue describes: the DM is on screen, she is gone.
  slate.close();

  // ── Send into the void: the row marks, with the reason under it ────────
  // exact: the sidebar's "Message a character" DM form would substring-match.
  const input = page.getByLabel("Message", { exact: true });
  await input.fill(MESSAGE);
  await input.press("Enter");

  const failed = log.getByTestId("failed-send");
  await expect(failed).toBeVisible({ timeout: 15_000 });
  await expect(failed).toContainText(MESSAGE);
  await expect(log.getByTestId("failed-send-reason")).toHaveText(
    "Not sent — Slate Harrow is offline",
  );
  // Nothing to retry while she is still away.
  await expect(log.getByTestId("failed-send-retry")).toBeDisabled();

  // The mark is durable, not a live-only flag: a reload must not resurrect
  // the message as delivered.
  await page.reload();
  await expect(page.getByTestId("failed-send-reason")).toHaveText(
    "Not sent — Slate Harrow is offline",
    { timeout: 20_000 },
  );

  // ── She comes back: retry delivers the same line ───────────────────────
  const slateAgain = await SimClient.connect(
    "slateharrow@example.test",
    "hunter2",
    "Slate Harrow",
  );
  try {
    const delivered = slateAgain.waitFor(
      "PRI",
      (payload: { character: string; message: string }) =>
        payload.message === MESSAGE,
      20_000,
    );
    const retry = page.getByTestId("failed-send-retry");
    await expect(retry).toBeEnabled({ timeout: 20_000 });
    await retry.click();
    await delivered;

    // The mark comes off the row that carried it — and there is still only
    // one copy of what the user wrote.
    await expect(page.getByTestId("failed-send")).toHaveCount(0, {
      timeout: 15_000,
    });
    await expect(
      page.getByTestId("message-log").getByText(MESSAGE),
    ).toHaveCount(1);
  } finally {
    slateAgain.close();
  }
});
