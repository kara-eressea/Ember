import { describe, expect, it } from "vitest";
import { isAppOrigin, isExternalWebUrl } from "./navigation.js";

const APP = "http://127.0.0.1:49231";

describe("isAppOrigin", () => {
  it("accepts the app's own pages", () => {
    expect(isAppOrigin(APP, `${APP}/`)).toBe(true);
    expect(isAppOrigin(APP, `${APP}/index.html#/chat`)).toBe(true);
  });

  it("refuses another port, another host spelling, another scheme", () => {
    // localhost and 127.0.0.1 are the same socket, but the renderer is only
    // ever handed one spelling — anything else is somebody else's page.
    expect(isAppOrigin(APP, "http://localhost:49231/")).toBe(false);
    expect(isAppOrigin(APP, "http://127.0.0.1:49232/")).toBe(false);
    expect(isAppOrigin(APP, "https://127.0.0.1:49231/")).toBe(false);
    expect(isAppOrigin(APP, "https://www.f-list.net/c/kara")).toBe(false);
  });

  it("refuses what is not a URL at all", () => {
    expect(isAppOrigin(APP, "")).toBe(false);
    expect(isAppOrigin(APP, "/relative/path")).toBe(false);
  });
});

describe("isExternalWebUrl", () => {
  it("is true for the links chat actually renders", () => {
    expect(isExternalWebUrl(APP, "https://www.f-list.net/c/kara")).toBe(true);
    expect(isExternalWebUrl(APP, "http://example.com/img.png")).toBe(true);
  });

  it("is false for the app itself", () => {
    expect(isExternalWebUrl(APP, `${APP}/settings`)).toBe(false);
  });

  it("refuses to hand non-web schemes to the OS", () => {
    expect(isExternalWebUrl(APP, "file:///etc/passwd")).toBe(false);
    expect(isExternalWebUrl(APP, "javascript:alert(1)")).toBe(false);
    expect(isExternalWebUrl(APP, "ms-msdt:/id")).toBe(false);
    expect(isExternalWebUrl(APP, "not a url")).toBe(false);
  });
});
