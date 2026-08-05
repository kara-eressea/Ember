// @vitest-environment jsdom

// The push opt-in flows (design/web-push.md §4), against a fake
// serviceWorker/PushManager pair — jsdom implements neither, and the browser
// halves of this (does a real push service hand back a subscription, does a
// real notification appear) are not testable anywhere. What IS worth pinning
// is the order the flow does things in, because each step of it is a promise
// the user paid for: the instance is asked whether push exists at all BEFORE
// the browser is prompted, the flag is only set once the server holds the
// endpoint, and every teardown clears the device flag even when the network
// half fails.

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from "vitest";
import { api } from "./api.js";
import {
  base64UrlToBytes,
  disablePush,
  enablePush,
  forgetPushOnLogout,
  pushEnabledHere,
  pushSupported,
  syncPushSubscription,
} from "./push.js";

const VAPID_KEY =
  "BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U";

/** The subscription a browser hands back, in `PushSubscription` shape. */
function fakeSubscription(endpoint: string, serverKey: Uint8Array) {
  return {
    endpoint,
    options: { applicationServerKey: serverKey.buffer },
    toJSON: () => ({ keys: { p256dh: "p256dh-value", auth: "auth-value" } }),
    unsubscribe: vi.fn().mockResolvedValue(true),
  };
}

interface FakeWorker {
  register: ReturnType<typeof vi.fn>;
  getRegistration: ReturnType<typeof vi.fn>;
  subscribe: ReturnType<typeof vi.fn>;
  getSubscription: ReturnType<typeof vi.fn>;
  unregister: ReturnType<typeof vi.fn>;
}

/** Installs `navigator.serviceWorker` + `window.PushManager` and returns the
 * spies behind them. */
function installFakeWorker(): FakeWorker {
  const subscribe = vi.fn();
  const getSubscription = vi.fn().mockResolvedValue(null);
  const unregister = vi.fn().mockResolvedValue(true);
  const registration = {
    pushManager: { subscribe, getSubscription },
    unregister,
  };
  const register = vi.fn().mockResolvedValue(registration);
  const getRegistration = vi.fn().mockResolvedValue(registration);
  Object.defineProperty(navigator, "serviceWorker", {
    value: { register, getRegistration },
    configurable: true,
  });
  Object.defineProperty(window, "PushManager", {
    value: class {},
    configurable: true,
  });
  return { register, getRegistration, subscribe, getSubscription, unregister };
}

function grantNotifications(permission: NotificationPermission): void {
  Object.defineProperty(window, "Notification", {
    value: Object.assign(class {}, {
      permission,
      requestPermission: () => Promise.resolve(permission),
    }),
    configurable: true,
  });
}

let worker: FakeWorker;
// Held as handles rather than asserted off `api.*`: a bare method reference
// is an unbound method, which is both a lint error and a real footgun.
let getVapidKey: MockInstance<typeof api.getPushVapidKey>;
let putSubscription: MockInstance<typeof api.putPushSubscription>;
let deleteSubscription: MockInstance<typeof api.deletePushSubscription>;

beforeEach(() => {
  localStorage.clear();
  worker = installFakeWorker();
  grantNotifications("granted");
  worker.subscribe.mockResolvedValue(
    fakeSubscription(
      "https://push.example.test/abc",
      base64UrlToBytes(VAPID_KEY),
    ),
  );
  getVapidKey = vi.spyOn(api, "getPushVapidKey").mockResolvedValue({
    enabled: true,
    key: VAPID_KEY,
  });
  putSubscription = vi
    .spyOn(api, "putPushSubscription")
    .mockResolvedValue({ ok: true });
  deleteSubscription = vi
    .spyOn(api, "deletePushSubscription")
    .mockResolvedValue({ removed: true });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("base64UrlToBytes", () => {
  it("decodes an unpadded, URL-safe VAPID key to its 65 bytes", () => {
    const bytes = base64UrlToBytes(VAPID_KEY);
    // A P-256 public key on the wire: 0x04 then the two 32-byte coordinates.
    expect(bytes).toHaveLength(65);
    expect(bytes[0]).toBe(0x04);
  });

  it("survives the characters plain base64 does not have", () => {
    // "-" and "_" stand in for "+" and "/", and the padding is gone.
    expect(base64UrlToBytes("-_-_")).toEqual(
      Uint8Array.from([0xfb, 0xff, 0xbf]),
    );
  });
});

describe("pushSupported", () => {
  it("wants both halves — a worker container and a PushManager", () => {
    expect(pushSupported()).toBe(true);
    // iOS Safari in a tab: service workers, no push until installed.
    Reflect.deleteProperty(window, "PushManager");
    expect(pushSupported()).toBe(false);
  });
});

describe("enablePush", () => {
  it("subscribes, PUTs the endpoint, and sets the device flag", async () => {
    await expect(enablePush()).resolves.toBe("enabled");

    expect(worker.register).toHaveBeenCalledWith("/sw.js");
    expect(worker.subscribe).toHaveBeenCalledWith({
      userVisibleOnly: true,
      applicationServerKey: base64UrlToBytes(VAPID_KEY),
    });
    expect(putSubscription).toHaveBeenCalledWith({
      endpoint: "https://push.example.test/abc",
      keys: { p256dh: "p256dh-value", auth: "auth-value" },
    });
    expect(pushEnabledHere()).toBe(true);
  });

  // The ordering that matters most in the whole module: an instance with no
  // VAPID keys can never deliver anything, so asking the browser for
  // notification permission there spends a one-shot prompt (Chrome will not
  // re-ask) on a feature that does not exist.
  it("checks the instance before prompting the browser", async () => {
    // "default" is the state where a prompt would actually be shown — the
    // one-shot the browser never offers twice.
    grantNotifications("default");
    getVapidKey.mockResolvedValue({ enabled: false });
    const requestPermission = vi.spyOn(Notification, "requestPermission");

    await expect(enablePush()).resolves.toBe("unavailable");

    expect(requestPermission).not.toHaveBeenCalled();
    expect(worker.register).not.toHaveBeenCalled();
    expect(pushEnabledHere()).toBe(false);
  });

  it("registers nothing when the browser refuses permission", async () => {
    grantNotifications("denied");

    await expect(enablePush()).resolves.toBe("denied");

    expect(worker.register).not.toHaveBeenCalled();
    expect(pushEnabledHere()).toBe(false);
  });

  // Half a subscription is worse than none: the browser would hold an
  // endpoint the server has never heard of, and the boot sync would think it
  // had nothing to heal.
  it("leaves the device opted out when the PUT fails", async () => {
    putSubscription.mockRejectedValue(new Error("nope"));

    await expect(enablePush()).resolves.toBe("failed");

    expect(pushEnabledHere()).toBe(false);
  });

  it("reuses an existing subscription minted against the same key", async () => {
    worker.getSubscription.mockResolvedValue(
      fakeSubscription(
        "https://push.example.test/existing",
        base64UrlToBytes(VAPID_KEY),
      ),
    );

    await expect(enablePush()).resolves.toBe("enabled");

    expect(worker.subscribe).not.toHaveBeenCalled();
    expect(putSubscription).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoint: "https://push.example.test/existing",
      }),
    );
  });

  // A self-host that regenerates its VAPID pair invalidates every endpoint
  // already out there. The old subscription is not merely stale, it is
  // undeliverable — keeping it alongside a new one would leave a browser
  // registered twice and reachable never.
  it("resubscribes when the instance rotated its VAPID key", async () => {
    const stale = fakeSubscription(
      "https://push.example.test/stale",
      Uint8Array.from([1, 2, 3]),
    );
    worker.getSubscription.mockResolvedValue(stale);

    await expect(enablePush()).resolves.toBe("enabled");

    expect(stale.unsubscribe).toHaveBeenCalled();
    expect(worker.subscribe).toHaveBeenCalled();
  });
});

describe("disablePush", () => {
  it("unsubscribes, DELETEs the endpoint and unregisters the worker", async () => {
    const subscription = fakeSubscription(
      "https://push.example.test/abc",
      base64UrlToBytes(VAPID_KEY),
    );
    worker.getSubscription.mockResolvedValue(subscription);
    localStorage.setItem("emberchat.pushEnabled", "1");

    await disablePush();

    expect(subscription.unsubscribe).toHaveBeenCalled();
    expect(deleteSubscription).toHaveBeenCalledWith(
      "https://push.example.test/abc",
    );
    expect(worker.unregister).toHaveBeenCalled();
    expect(pushEnabledHere()).toBe(false);
  });

  it("still opts the device out when the server call fails", async () => {
    worker.getSubscription.mockResolvedValue(
      fakeSubscription(
        "https://push.example.test/abc",
        base64UrlToBytes(VAPID_KEY),
      ),
    );
    deleteSubscription.mockRejectedValue(new Error("down"));
    localStorage.setItem("emberchat.pushEnabled", "1");

    await disablePush();

    expect(pushEnabledHere()).toBe(false);
    expect(worker.unregister).toHaveBeenCalled();
  });
});

describe("syncPushSubscription", () => {
  it("does nothing at all for a device that never opted in", async () => {
    await syncPushSubscription();

    expect(getVapidKey).not.toHaveBeenCalled();
    expect(worker.register).not.toHaveBeenCalled();
  });

  // Subscriptions rotate without asking; re-PUTting on every boot is what
  // keeps the server's copy the one the browser actually holds.
  it("re-registers and re-PUTs for a device that did", async () => {
    localStorage.setItem("emberchat.pushEnabled", "1");

    await syncPushSubscription();

    expect(worker.register).toHaveBeenCalledWith("/sw.js");
    expect(putSubscription).toHaveBeenCalledWith(
      expect.objectContaining({ endpoint: "https://push.example.test/abc" }),
    );
  });

  it("tears the local footprint down when the instance dropped its keys", async () => {
    localStorage.setItem("emberchat.pushEnabled", "1");
    worker.getSubscription.mockResolvedValue(
      fakeSubscription(
        "https://push.example.test/abc",
        base64UrlToBytes(VAPID_KEY),
      ),
    );
    getVapidKey.mockResolvedValue({ enabled: false });

    await syncPushSubscription();

    expect(worker.unregister).toHaveBeenCalled();
    expect(pushEnabledHere()).toBe(false);
  });

  it("stays quiet when a network failure answers instead of the server", async () => {
    localStorage.setItem("emberchat.pushEnabled", "1");
    getVapidKey.mockRejectedValue(new Error("offline"));

    await expect(syncPushSubscription()).resolves.toBeUndefined();

    // Still opted in: a blip is not a signal that the user changed their mind.
    expect(pushEnabledHere()).toBe(true);
  });
});

describe("forgetPushOnLogout", () => {
  // The server side is already handled by the auth-session cascade, so this
  // is purely about not leaving a live endpoint on a machine somebody just
  // signed out of — and it must not call an API it no longer has a token for.
  it("unregisters locally without touching the server", async () => {
    const subscription = fakeSubscription(
      "https://push.example.test/abc",
      base64UrlToBytes(VAPID_KEY),
    );
    worker.getSubscription.mockResolvedValue(subscription);
    localStorage.setItem("emberchat.pushEnabled", "1");

    await forgetPushOnLogout();

    expect(subscription.unsubscribe).toHaveBeenCalled();
    expect(worker.unregister).toHaveBeenCalled();
    expect(deleteSubscription).not.toHaveBeenCalled();
    expect(pushEnabledHere()).toBe(false);
  });

  it("is a no-op for a device that never opted in", async () => {
    await forgetPushOnLogout();

    expect(worker.getRegistration).not.toHaveBeenCalled();
  });
});
