// Web Push, the half a browser can be driven through (design/web-push.md §5):
// the preferences toggle appears when the instance has VAPID keys, enabling it
// registers the service worker and PUTs the subscription, and disabling it
// unregisters and DELETEs. The stack's keypair is minted per run in
// global-setup, so `/api/push/vapid-key` reports enabled here.
//
// What this spec deliberately does NOT do is receive a push. That needs a live
// push service (FCM, Mozilla's autopush, Apple's) reachable from both the
// browser and the server, which no CI has and no fixture can stand in for.
// Delivery, the notification's own appearance and the tap that routes back
// into a conversation are all on design/mobile-device-checklist.md instead.
//
// TWO browser-owned pieces are therefore replaced at `addInitScript` time, and
// both because headless Chromium refuses them outright rather than because
// they are inconvenient:
//
//   - `Notification.permission` reads "denied" in headless no matter what
//     Playwright is told (measured 2026-08-05: the `permissions` context
//     option and an explicit per-origin `grantPermissions` both leave it
//     denied), so the opt-in could never get past `ensureNotifyPermission`.
//   - `pushManager.subscribe` needs a connection to a real push service, which
//     a headless browser has not got, so it rejects before any client code of
//     ours is reached.
//
// Everything between them is the shipping path: the registration, the
// base64url key conversion, the request bodies the server sees, and the whole
// teardown. Only the browser's own handshakes are stubbed.
//
// Owns pushwort@example.test (Pushwort Kell): specs never share an account or
// a character (world.ts). This one needs no partner — it sends no messages.

import { type Page } from "@playwright/test";
import {
  expect,
  interceptAvatars,
  provisionAndConnect,
  test,
} from "./helpers.js";

const ACCOUNT = "pushwort@example.test";
const CHARACTER = "Pushwort Kell";

/** A granted notification permission, which headless Chromium will not give.
 * Both halves: the flow reads `permission` and, on "default", would prompt. */
async function grantNotifications(page: Page): Promise<void> {
  await page.addInitScript(() => {
    Object.defineProperty(Notification, "permission", {
      configurable: true,
      get: () => "granted",
    });
    Object.defineProperty(Notification, "requestPermission", {
      configurable: true,
      value: () => Promise.resolve("granted"),
    });
  });
}

/**
 * Stand in for the browser's push service. `subscribe` mints a subscription
 * that echoes back the `applicationServerKey` it was handed — which is what
 * the client's key-rotation check compares against — and the pair behaves like
 * a real one across unsubscribe, so `getSubscription` answers null afterwards.
 */
async function fakePushService(page: Page): Promise<void> {
  await page.addInitScript(() => {
    let current: unknown = null;
    Object.assign(PushManager.prototype, {
      subscribe(options: { applicationServerKey: BufferSource }) {
        const endpoint =
          "https://push.example.test/" + Math.random().toString(36).slice(2);
        current = {
          endpoint,
          options: { applicationServerKey: options.applicationServerKey },
          toJSON: () => ({
            endpoint,
            keys: { p256dh: "fake-p256dh-key", auth: "fake-auth-secret" },
          }),
          unsubscribe: () => {
            current = null;
            return Promise.resolve(true);
          },
        };
        return Promise.resolve(current);
      },
      getSubscription() {
        return Promise.resolve(current);
      },
    });
  });
}

/** Open Preferences on the Notifications pane. */
async function openNotificationPrefs(page: Page) {
  await page.getByRole("button", { name: "Preferences" }).click();
  const dialog = page.getByRole("dialog", { name: "Preferences" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Notifications" }).click();
  await expect(
    dialog.getByRole("heading", { name: "Notifications" }),
  ).toBeVisible();
  return dialog;
}

/** Whether this browser currently holds a service-worker registration. */
function hasRegistration(page: Page): Promise<boolean> {
  return page.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration();
    return registration !== undefined;
  });
}

test("push: the per-device toggle subscribes and unsubscribes this browser", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await interceptAvatars(page);
  await grantNotifications(page);
  await fakePushService(page);

  await provisionAndConnect(page, ACCOUNT, CHARACTER);

  const dialog = await openNotificationPrefs(page);

  // The instance has keys, so the whole group renders — and it is per device,
  // not per identity, which the copy and the iOS hint both say out loud.
  const toggle = dialog.getByRole("switch", {
    name: "Push notifications on this device",
  });
  await expect(toggle).toBeVisible();
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await expect(dialog.getByText(/Home Screen/)).toBeVisible();

  // Nothing is registered until the user asks for it (invariant 2): opting out
  // is the default, and the default costs no service worker at all.
  expect(await hasRegistration(page)).toBe(false);

  // ── Enable ───────────────────────────────────────────────────────────────
  const put = page.waitForRequest(
    (request) =>
      request.url().includes("/api/push/subscription") &&
      request.method() === "PUT",
  );
  await toggle.click();
  const putBody = (await put).postDataJSON() as {
    endpoint: string;
    keys: { p256dh: string; auth: string };
  };

  await expect(toggle).toHaveAttribute("aria-checked", "true");
  expect(putBody.endpoint).toContain("https://push.example.test/");
  expect(putBody.keys).toEqual({
    p256dh: "fake-p256dh-key",
    auth: "fake-auth-secret",
  });
  // The worker itself is real, served from public/ at the origin root.
  await expect.poll(() => hasRegistration(page), { timeout: 10_000 }).toBe(true);

  // ── Disable ──────────────────────────────────────────────────────────────
  const removed = page.waitForRequest(
    (request) =>
      request.url().includes("/api/push/subscription") &&
      request.method() === "DELETE",
  );
  await toggle.click();
  const removedBody = (await removed).postDataJSON() as { endpoint: string };

  await expect(toggle).toHaveAttribute("aria-checked", "false");
  expect(removedBody.endpoint).toBe(putBody.endpoint);
  // Unregistered, not merely unsubscribed: opting out takes the whole
  // footprint back down with it (web-push.md §4).
  await expect
    .poll(() => hasRegistration(page), { timeout: 10_000 })
    .toBe(false);
});
