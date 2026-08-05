// Web Push subscription lifecycle (design/web-push.md §4) — the one module in
// the client allowed to name a service worker, and the reason the guard in
// `shipping-shape.test.ts` names it by path.
//
// Two rules shape everything here:
//
//   1. The worker is registered ONLY for a browser that opted in (invariant
//      2). The opt-in is a localStorage flag because it is device state, not
//      user state: the same account on a desktop and a phone wants different
//      answers, and server prefs cannot hold two. A user who never flips the
//      toggle never has a worker registered at all, so MP3's zero-worker
//      footprint is unchanged for everyone else.
//   2. Nothing here is load-bearing. Push is an extra channel on top of a
//      client that already streams over its socket, so every failure is
//      swallowed at the call site's edge — a push service that is down must
//      never take a preferences pane or a logout with it.

import {
  ensureNotifyPermission,
  notificationsSupported,
} from "./desktop-notify.js";
import { api } from "./api.js";

/** Where the worker lives — root scope, so `clients.openWindow` can land on
 * any app route. Served straight out of `public/` (Vite copies it to the dist
 * root; the server adds `cache-control: no-cache` for it). */
const WORKER_URL = "/sw.js";

/** Device-scoped opt-in. Frozen alongside the other `emberchat.*` keys. */
const ENABLED_KEY = "emberchat.pushEnabled";

export type PushEnableResult =
  /** Subscribed; the server has this browser's endpoint. */
  | "enabled"
  /** The browser refuses notifications, now or stickily. */
  | "denied"
  /** No `PushManager`/`serviceWorker` here — iOS Safari in a tab, mostly. */
  | "unsupported"
  /** This instance has no VAPID keys, so nothing could ever be sent. */
  | "unavailable"
  /** The push service or the subscribe call failed. */
  | "failed";

/** Whether this browser can subscribe at all. iOS only grows a `PushManager`
 * once the app is installed to the home screen, which is exactly why the
 * prefs pane says so out loud rather than showing a toggle that cannot work. */
export function pushSupported(): boolean {
  return (
    typeof navigator !== "undefined" &&
    "serviceWorker" in navigator &&
    typeof window !== "undefined" &&
    "PushManager" in window
  );
}

/** The device flag. Read on boot, and by the prefs toggle for its state. */
export function pushEnabledHere(): boolean {
  try {
    return localStorage.getItem(ENABLED_KEY) === "1";
  } catch {
    return false; // storage disabled entirely — treat as opted out
  }
}

function setEnabledHere(enabled: boolean): void {
  try {
    if (enabled) {
      localStorage.setItem(ENABLED_KEY, "1");
    } else {
      localStorage.removeItem(ENABLED_KEY);
    }
  } catch {
    // Private-mode storage refusals cost the flag, not the subscription.
  }
}

/**
 * VAPID keys travel as base64url and `subscribe` wants bytes. Not
 * `Buffer.from` — this runs in a browser — and not a URL-safe `atob`, because
 * there is no such thing.
 */
export function base64UrlToBytes(base64Url: string): Uint8Array<ArrayBuffer> {
  const base64 = base64Url.replaceAll("-", "+").replaceAll("_", "/");
  const padded = base64.padEnd(
    base64.length + ((4 - (base64.length % 4)) % 4),
    "=",
  );
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

/** The wire shape the routes take — `PushSubscription.toJSON()` minus the
 * expiration time nobody reads. */
function subscriptionBody(subscription: PushSubscription): {
  endpoint: string;
  keys: { p256dh: string; auth: string };
} {
  const json = subscription.toJSON();
  return {
    endpoint: subscription.endpoint,
    keys: {
      p256dh: json.keys?.["p256dh"] ?? "",
      auth: json.keys?.["auth"] ?? "",
    },
  };
}

function sameServerKey(
  subscription: PushSubscription,
  expected: Uint8Array,
): boolean {
  const actual = subscription.options.applicationServerKey;
  if (!actual) {
    return false;
  }
  const bytes = new Uint8Array(actual);
  if (bytes.length !== expected.length) {
    return false;
  }
  return bytes.every((byte, index) => byte === expected[index]);
}

/**
 * The browser's subscription for `key`, reusing the existing one when it was
 * minted against the same VAPID key. A mismatch means the instance rotated
 * its keypair: the old subscription is undeliverable from here on, so it is
 * dropped rather than kept alongside a new one.
 */
async function subscribeFor(
  registration: ServiceWorkerRegistration,
  key: string,
): Promise<PushSubscription> {
  const applicationServerKey = base64UrlToBytes(key);
  const existing = await registration.pushManager.getSubscription();
  if (existing) {
    if (sameServerKey(existing, applicationServerKey)) {
      return existing;
    }
    await existing.unsubscribe();
  }
  return registration.pushManager.subscribe({
    // Non-negotiable on every engine that implements push: a subscription that
    // does not promise a visible notification is refused outright.
    userVisibleOnly: true,
    applicationServerKey,
  });
}

/**
 * The prefs toggle turning on. Order matters: the instance's capability is
 * checked before the browser is prompted, so a self-host without VAPID keys
 * never costs a user a permission dialog it could not honour.
 */
export async function enablePush(): Promise<PushEnableResult> {
  if (!pushSupported()) {
    return "unsupported";
  }
  let key: string | undefined;
  try {
    const capability = await api.getPushVapidKey();
    key = capability.enabled ? capability.key : undefined;
  } catch {
    return "failed";
  }
  if (key === undefined) {
    return "unavailable";
  }
  const permission = await ensureNotifyPermission();
  if (permission !== "granted") {
    return permission === "unsupported" ? "unsupported" : "denied";
  }
  try {
    const registration = await navigator.serviceWorker.register(WORKER_URL);
    const subscription = await subscribeFor(registration, key);
    await api.putPushSubscription(subscriptionBody(subscription));
  } catch (error) {
    console.debug("push: subscribe failed", error);
    return "failed";
  }
  setEnabledHere(true);
  return "enabled";
}

/**
 * The toggle turning off, and the shape every teardown here shares: local
 * first, server second, and the flag last. Local-first because the flag is
 * what boot reads — a server call that fails must still leave this device
 * genuinely unsubscribed rather than opted in and silent.
 */
export async function disablePush(): Promise<void> {
  setEnabledHere(false);
  await unsubscribeLocally(true);
}

/**
 * Drop this browser's registration. `tellServer` is false on logout, where
 * the auth-session cascade has already deleted the row and the access token
 * is gone anyway.
 */
async function unsubscribeLocally(tellServer: boolean): Promise<void> {
  if (!pushSupported()) {
    return;
  }
  try {
    const registration = await navigator.serviceWorker.getRegistration();
    if (!registration) {
      return;
    }
    const subscription = await registration.pushManager.getSubscription();
    if (subscription) {
      await subscription.unsubscribe();
      if (tellServer) {
        try {
          await api.deletePushSubscription(subscription.endpoint);
        } catch {
          // The row outlives the endpoint for a while and the sender prunes
          // it on the push service's first 410 — worth trying, never worth
          // failing over.
        }
      }
    }
    await registration.unregister();
  } catch (error) {
    console.debug("push: unsubscribe failed", error);
  }
}

/**
 * Boot, for a device that opted in: re-register and re-PUT.
 *
 * The re-PUT is the point, not the re-register. Push subscriptions rotate on
 * their own — a browser update, a long silence, the push service's own
 * housekeeping — and a rotated endpoint leaves the server holding one that is
 * dead and the browser holding one nobody knows about. Sending it again on
 * every boot is the standard self-heal, and the route upserts on endpoint so
 * the common case (nothing changed) costs one row's worth of nothing.
 *
 * Runs after authentication (the shell mounts it) because both calls need a
 * token.
 */
export async function syncPushSubscription(): Promise<void> {
  if (!pushEnabledHere()) {
    return;
  }
  if (!pushSupported()) {
    setEnabledHere(false);
    return;
  }
  try {
    const capability = await api.getPushVapidKey();
    const key = capability.enabled ? capability.key : undefined;
    if (key === undefined) {
      // The instance turned push off since this device opted in. Take the
      // footprint down with it rather than leave a worker registered for a
      // feature that no longer exists.
      await disablePush();
      return;
    }
    if (!notificationsSupported() || Notification.permission !== "granted") {
      // Revoked in browser settings after opting in — the prefs pane says so;
      // here it just means there is nothing to re-register.
      return;
    }
    const registration = await navigator.serviceWorker.register(WORKER_URL);
    const subscription = await subscribeFor(registration, key);
    await api.putPushSubscription(subscriptionBody(subscription));
  } catch (error) {
    console.debug("push: boot sync failed", error);
  }
}

/**
 * Logout. Best-effort and detached by the caller: the server side is already
 * handled (the subscription row cascades off the auth session), so this is
 * only about not leaving a worker and a live endpoint behind on a machine
 * somebody just signed out of.
 */
export async function forgetPushOnLogout(): Promise<void> {
  if (!pushEnabledHere()) {
    return;
  }
  setEnabledHere(false);
  await unsubscribeLocally(false);
}
