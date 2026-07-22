// Privacy gate for profile/guestbook [img] rendering (#263). A direct-URL
// [img] hotlinks straight from the viewer's browser, leaking IP + referrer to
// an author-chosen host, so it must resolve only when the host is on the
// user's imagePreviewHosts allowlist. The inline-id path (server-constructed
// static.f-list.net URLs) stays ungated.
//
// resolveImgSrc holds all the gating logic and is unit-tested here. The
// rendered <img referrerPolicy="no-referrer"> and the lightbox-open path
// (which only opens for images that already resolved via resolveImgSrc) live
// in the React component; apps/web has no component-test layer yet, so those
// are covered by assertion-in-code + the profile e2e rather than a DOM render.
import { describe, expect, it } from "vitest";
import type { ProfileInline } from "@emberchat/protocol";
import { resolveImgSrc } from "./ProfileBBCode.js";

const ALLOW = ["static.f-list.net", "imgur.com", "i.imgur.com"];

describe("resolveImgSrc (#263 img allowlist gate)", () => {
  it("resolves a direct URL whose host is on the allowlist", () => {
    expect(resolveImgSrc("https://i.imgur.com/abc123.png", {}, ALLOW)).toBe(
      "https://i.imgur.com/abc123.png",
    );
  });

  it("matches allowlist subdomains (apex covers i./cdn./www.)", () => {
    // "imgur.com" on the list covers the "i.imgur.com" subdomain.
    expect(resolveImgSrc("https://i.imgur.com/x.png", {}, ["imgur.com"])).toBe(
      "https://i.imgur.com/x.png",
    );
  });

  it("blocks a direct URL whose host is NOT on the allowlist", () => {
    expect(
      resolveImgSrc("https://tracker.example.com/pixel.png", {}, ALLOW),
    ).toBeUndefined();
  });

  it("blocks a direct URL when the allowlist is empty", () => {
    expect(
      resolveImgSrc("https://i.imgur.com/abc123.png", {}, []),
    ).toBeUndefined();
  });

  it("does not treat a substring host as an allowlist match", () => {
    // "evilimgur.com" must not match "imgur.com" — only exact host or a
    // dot-boundary subdomain counts (hostAllowed semantics).
    expect(
      resolveImgSrc("https://evilimgur.com/x.png", {}, ["imgur.com"]),
    ).toBeUndefined();
  });

  it("resolves the inline-id path regardless of the allowlist", () => {
    const inlines: Record<string, ProfileInline> = {
      "42": { url: "https://static.f-list.net/images/charinline/1/2/42.png" },
    };
    // Empty allowlist — the inline id still resolves because the server
    // constructs that host; the gate only applies to direct URLs.
    expect(resolveImgSrc("42", inlines, [])).toBe(
      "https://static.f-list.net/images/charinline/1/2/42.png",
    );
  });

  it("prefers the inline map over allowlist checks for a matching id", () => {
    const inlines: Record<string, ProfileInline> = {
      foo: { url: "https://static.f-list.net/x.png" },
    };
    expect(resolveImgSrc("foo", inlines, ["imgur.com"])).toBe(
      "https://static.f-list.net/x.png",
    );
  });

  it("returns undefined for a non-URL, non-inline reference", () => {
    expect(resolveImgSrc("not a url or id", {}, ALLOW)).toBeUndefined();
  });

  it("returns undefined for a non-http(s) scheme even if it parses", () => {
    // validHref rejects javascript:/data: etc.; a blocked ref degrades to the
    // quiet placeholder.
    expect(resolveImgSrc("javascript:alert(1)", {}, ALLOW)).toBeUndefined();
  });
});
