// Typing indicator placement (#336): the partner's TPN status rests on a slim
// line directly above the message bar (Discord-style), not in the DM header.
// A raw SimClient plays the "other side", pushing TPN states; the line reflects
// them in plain language, reserves its height when clear so the message log
// never jumps, and lives inside the composer (below the log, above the input).
// Owns yarrow@example.test (Yarrow Dale; Rowan Birch is the other side).

import { expect, test } from "@playwright/test";
import { SimClient, interceptAvatars, provisionAndConnect } from "./helpers.js";

test("typing status shows on the message bar and clears again", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await interceptAvatars(page);

  await provisionAndConnect(page, "yarrow@example.test", "Yarrow Dale");

  const rowan = await SimClient.connect(
    "yarrow@example.test",
    "hunter2",
    "Rowan Birch",
  );
  try {
    // Rowan opens the conversation with an inbound PM, then the DM is selected.
    rowan.send("PRI", {
      recipient: "Yarrow Dale",
      message: "Are you around?",
    });
    const nav = page.getByRole("navigation");
    await nav.getByRole("link", { name: /Rowan Birch/ }).click();
    await expect(page).toHaveURL(/\/dm\/Rowan%20Birch$/);

    const typingLine = page.getByTestId("typing-line");
    // Reserved but empty before any TPN arrives — the line exists so the log
    // never jumps when the status comes and goes.
    await expect(typingLine).toBeVisible();
    await expect(typingLine).toHaveText("");

    // The line sits below the message log and above the input bar (#336).
    const input = page.getByRole("textbox", { name: "Message" });
    const lineBox = await typingLine.boundingBox();
    const inputBox = await input.boundingBox();
    expect(lineBox).not.toBeNull();
    expect(inputBox).not.toBeNull();
    expect(lineBox!.y).toBeLessThan(inputBox!.y);

    // ── typing ────────────────────────────────────────────────────────────
    rowan.send("TPN", { character: "Yarrow Dale", status: "typing" });
    await expect(typingLine).toHaveText("Rowan Birch is typing…");

    // Shown in exactly one place — the header no longer duplicates it (#336).
    await expect(page.getByText("Rowan Birch is typing…")).toHaveCount(1);

    // ── paused (plain language) ─────────────────────────────────────────────
    rowan.send("TPN", { character: "Yarrow Dale", status: "paused" });
    await expect(typingLine).toHaveText("Rowan Birch has typed something");

    // ── clear: the text goes away, the reserved line stays ─────────────────
    rowan.send("TPN", { character: "Yarrow Dale", status: "clear" });
    await expect(typingLine).toHaveText("");
    await expect(typingLine).toBeVisible();
  } finally {
    rowan.close();
  }
});
