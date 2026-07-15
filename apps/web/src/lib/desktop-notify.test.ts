// previewText: BBCode-stripped one-liners for notification bodies; the
// Notification-API paths no-op outside a browser (node environment) — that
// safety is itself worth pinning.

import { describe, expect, it } from "vitest";
import {
  ensureNotifyPermission,
  notificationsSupported,
  previewText,
  showMessageNotification,
} from "./desktop-notify.js";

describe("previewText", () => {
  it("strips BBCode tags and trims", () => {
    expect(previewText("[b]Amber[/b], [i]look[/i] at this ")).toBe(
      "Amber, look at this",
    );
    expect(previewText("[url=https://example.test]a link[/url]")).toBe(
      "a link",
    );
    // Tag contents are content: an eicon previews as its name.
    expect(previewText("[eicon]dancingcrab[/eicon]")).toBe("dancingcrab");
  });

  it("truncates long previews with an ellipsis", () => {
    const long = "a".repeat(300);
    const preview = previewText(long);
    expect(preview.length).toBe(120);
    expect(preview.endsWith("…")).toBe(true);
  });
});

describe("without a Notification API (node)", () => {
  it("reports unsupported and stays silent instead of throwing", async () => {
    expect(notificationsSupported()).toBe(false);
    await expect(ensureNotifyPermission()).resolves.toBe("unsupported");
    expect(() => {
      showMessageNotification({ title: "x", tag: "t" });
    }).not.toThrow();
  });
});
