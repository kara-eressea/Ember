// The sleep/wake give-up (user report, v0.19.2, Firefox, MacBook sleep): the
// tab came back saying "not connected" and never tried again — only a reload
// fixed it. The storm behind it, in order: the access token expired while the
// machine slept, so the reconnect's hello was refused (4401); the client's one
// token refresh then went out while the Wi-Fi was still re-associating and
// failed at the network level; and a refresh that fails for ANY reason was
// read as "signed out", which parked the client permanently — past the wake
// probe, which returns early once the client has stopped wanting a socket.
//
// Both halves are faked honestly here: the WS route closes the live socket
// with the server's own 4401, and the refresh POST is aborted at the network
// layer exactly once. Nothing else is stubbed — the recovery is the real
// backoff opening a real socket that reaches the real bouncer.
//
// Owns drowse@example.test (Fallow Drowse); specs never share an account or a
// character.

import {
  expect,
  interceptAvatars,
  joinChannel,
  provisionAndConnect,
  test,
} from "./helpers.js";

test("a refused hello and a failed refresh do not end the tab's reconnecting", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await interceptAvatars(page);

  // Proxy the gateway so the spec can close the live socket the way the
  // server closes an expired hello. Reconnects re-enter this handler and pass
  // straight through — the recovery path is untouched.
  let refuse: (() => Promise<void>) | undefined;
  await page.routeWebSocket(/\/gateway/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((message) => {
      server.send(message);
    });
    server.onMessage((message) => {
      ws.send(message);
    });
    refuse = () => ws.close({ code: 4401, reason: "invalid token" });
  });

  await provisionAndConnect(page, "drowse@example.test", "Fallow Drowse");
  await joinChannel(page, "Frontpage");

  // The wake storm: the next refresh never reaches the server.
  let refreshes = 0;
  await page.route("**/api/auth/refresh", async (route) => {
    refreshes += 1;
    if (refreshes === 1) {
      await route.abort("connectionfailed");
      return;
    }
    await route.fallback();
  });

  await refuse!();

  // The head says so — quietly, and clickably.
  const chip = page.getByRole("button", { name: "Reconnect now" });
  await expect(chip).toBeVisible({ timeout: 15_000 });
  await expect
    .poll(() => refreshes, { timeout: 15_000 })
    .toBeGreaterThanOrEqual(1);

  // …and then it heals itself, on the reconnect backoff, with no reload and
  // no click. (Before the fix this chip stayed up forever.)
  await expect(chip).toHaveCount(0, { timeout: 30_000 });

  // Really back, not merely painted back: a message round-trips through the
  // new socket to the bouncer and its F-Chat session.
  const composer = page.getByRole("textbox", { name: "Message", exact: true });
  await composer.fill("still here");
  await composer.press("Enter");
  await expect(
    page.getByTestId("message-log").getByText("still here"),
  ).toBeVisible({ timeout: 15_000 });
});
