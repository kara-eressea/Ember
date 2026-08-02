// Regression for the parallel-load hang family's Shape B (diagnosed
// 2026-08-02): a full page navigation aborts an in-flight
// POST /api/auth/refresh AFTER the server committed the rotation but BEFORE
// the response reached the browser. localStorage then still holds the burnt
// token; with strictly single-use rotation the next boot's refresh got 401,
// the app bounced to /login, and any spec waiting for the identity picker's
// "Open" button hung out its whole budget. The server now honours the
// pre-rotation token for a short grace window (ROTATION_GRACE_MS) — this
// spec makes the lost response deterministic instead of hoping for CI load.
//
// Owns gracewell@example.test (Verity Gracewell); specs never share an
// account or a character.

import {
  expect,
  interceptAvatars,
  provisionAndConnect,
  test,
} from "./helpers.js";

test("a refresh response lost mid-rotation does not log the session out", async ({
  page,
}) => {
  await interceptAvatars(page);
  await provisionAndConnect(page, "gracewell@example.test", "Verity Gracewell");

  // Swallow exactly one refresh: let the server process it (the rotation
  // commits), then drop the response on the floor — the trace-verified shape
  // of a navigation racing the boot-time refresh.
  let sink!: () => void;
  const responseLost = new Promise<void>((resolve) => (sink = resolve));
  await page.route("**/api/auth/refresh", async (route) => {
    await route.fetch();
    sink();
    // Never fulfilled: the browser keeps waiting until navigation aborts it.
  });

  // A full navigation boots the app, and boot always refreshes.
  await page.goto("/app/Verity%20Gracewell");
  await responseLost;
  await page.unroute("**/api/auth/refresh");

  // Reattach: the boot refresh presents the pre-rotation token. Within the
  // grace it must redeem — the picker renders with the live session's Open,
  // not the login form.
  await page.goto("/identities");
  await expect(
    page.getByRole("button", { name: "Open", exact: true }),
  ).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("heading", { name: "Log in" })).toHaveCount(0);
});
