import { describe, expect, it } from "vitest";
import {
  chipHost,
  chipLabel,
  hostAllowed,
  resolvePreview,
} from "./link-preview.js";

describe("resolvePreview", () => {
  it("recognizes direct image and video extensions, case-insensitively", () => {
    expect(resolvePreview("https://cdn.example.com/a/pic.JPG")).toMatchObject({
      kind: "image",
      src: "https://cdn.example.com/a/pic.JPG",
    });
    expect(resolvePreview("https://cdn.example.com/clip.webm")).toMatchObject({
      kind: "video",
    });
  });

  it("rewrites imgur single-image pages to the direct host", () => {
    expect(resolvePreview("https://imgur.com/aB3dE9f")).toMatchObject({
      src: "https://i.imgur.com/aB3dE9f.jpg",
      kind: "image",
      host: "imgur.com",
    });
    // Albums and galleries have no derivable single image.
    expect(resolvePreview("https://imgur.com/a/aB3dE9f")).toBeUndefined();
    expect(resolvePreview("https://imgur.com/gallery/xyz")).toBeUndefined();
  });

  it("treats everything else as a plain link", () => {
    expect(resolvePreview("https://example.com/article")).toBeUndefined();
    expect(resolvePreview("https://example.com/")).toBeUndefined();
    expect(resolvePreview("not a url")).toBeUndefined();
    expect(resolvePreview("ftp://example.com/pic.png")).toBeUndefined();
  });

  it("ignores query strings when testing the extension", () => {
    // The extension test runs on the pathname, not the query.
    expect(resolvePreview("https://x.test/pic.png?w=200")).toMatchObject({
      kind: "image",
    });
    expect(resolvePreview("https://x.test/page?img=pic.png")).toBeUndefined();
  });

  it("recognizes pbs.twimg.com images via the format= query param", () => {
    // Twitter/X carries the type in the query, not the path; the full URL
    // (including name=large) must survive onto the src.
    const href = "https://pbs.twimg.com/media/AbC123?format=jpg&name=large";
    expect(resolvePreview(href)).toMatchObject({
      kind: "image",
      src: href,
      host: "pbs.twimg.com",
    });
    expect(
      resolvePreview("https://pbs.twimg.com/media/AbC123?format=png"),
    ).toMatchObject({ kind: "image" });
    // No/other format = not an image we can classify.
    expect(
      resolvePreview("https://pbs.twimg.com/media/AbC123"),
    ).toBeUndefined();
    expect(
      resolvePreview("https://pbs.twimg.com/media/AbC123?format=json"),
    ).toBeUndefined();
  });

  it("rewrites gyazo share pages to the direct i.gyazo.com image", () => {
    expect(
      resolvePreview("https://gyazo.com/0123456789abcdef0123456789abcdef"),
    ).toMatchObject({
      src: "https://i.gyazo.com/0123456789abcdef0123456789abcdef.png",
      kind: "image",
      host: "gyazo.com",
    });
    // Non-id sub-paths have no single derivable image.
    expect(resolvePreview("https://gyazo.com/captures")).toBeUndefined();
    expect(
      resolvePreview("https://gyazo.com/0123456789abcdef/thumb"),
    ).toBeUndefined();
  });

  it("rewrites x.com / twitter.com status links to the fixvx direct-media host (#384)", () => {
    expect(
      resolvePreview("https://x.com/someone/status/1234567890"),
    ).toMatchObject({
      src: "https://d.fixvx.com/someone/status/1234567890",
      kind: "image",
      host: "x.com",
    });
    // twitter.com and the vx/fixup mirrors resolve the same way; trailing
    // /photo/1-style segments are tolerated.
    expect(
      resolvePreview("https://twitter.com/a_user/status/42/photo/1"),
    ).toMatchObject({ src: "https://d.fixvx.com/a_user/status/42" });
    // Non-status pages (profiles, home) have no derivable media.
    expect(resolvePreview("https://x.com/someone")).toBeUndefined();
    expect(resolvePreview("https://x.com/home")).toBeUndefined();
  });

  it("gates the fixvx rewrite on the effective direct-media host (#384)", () => {
    // The gate is on d.fixvx.com (the rewrite target), not x.com.
    expect(
      resolvePreview("https://x.com/u/status/1", ["d.fixvx.com"]),
    ).toMatchObject({ src: "https://d.fixvx.com/u/status/1" });
    expect(
      resolvePreview("https://x.com/u/status/1", ["x.com"]),
    ).toBeUndefined();
  });

  it("previews a direct-media host with no file extension (#384)", () => {
    // d.fixvx.com serves media at an extensionless path — the extension test
    // is waived for hosts on the direct-media table.
    expect(
      resolvePreview("https://d.fixvx.com/u/status/9", ["d.fixvx.com"]),
    ).toMatchObject({ kind: "image", host: "d.fixvx.com" });
    // Still gated: an extensionless direct-media URL off the allowlist stays
    // a plain link.
    expect(
      resolvePreview("https://d.fixvx.com/u/status/9", ["imgur.com"]),
    ).toBeUndefined();
  });

  it("previews cdn.discordapp.com images with signed query params intact", () => {
    // The path already ends in .png; the signed ex/is/hm query must survive
    // verbatim onto the src or the CDN 403s.
    const href =
      "https://cdn.discordapp.com/attachments/1/2/pic.png?ex=abc&is=def&hm=deadbeef";
    expect(resolvePreview(href)).toMatchObject({
      kind: "image",
      src: href,
      host: "cdn.discordapp.com",
    });
  });
});

describe("hostAllowed", () => {
  it("matches exact hosts and subdomains, case-insensitively", () => {
    const list = ["xariah.net", "imgur.com"];
    expect(hostAllowed("xariah.net", list)).toBe(true);
    expect(hostAllowed("XARIAH.NET", list)).toBe(true);
    // Subdomain of a listed apex is covered.
    expect(hostAllowed("i.imgur.com", list)).toBe(true);
    expect(hostAllowed("cdn.imgur.com", list)).toBe(true);
    // Unlisted host, and a look-alike that only ends with the string.
    expect(hostAllowed("evil.com", list)).toBe(false);
    expect(hostAllowed("notimgur.com", list)).toBe(false);
    expect(hostAllowed("imgur.com.evil.com", list)).toBe(false);
  });

  it("returns false for an empty allowlist", () => {
    expect(hostAllowed("imgur.com", [])).toBe(false);
  });
});

describe("resolvePreview allowlist gating (#215)", () => {
  it("returns the source only when the media host is allowed", () => {
    const allow = ["static.f-list.net"];
    expect(
      resolvePreview("https://static.f-list.net/images/a/pic.png", allow),
    ).toMatchObject({ kind: "image", host: "static.f-list.net" });
    // Not on the list → plain link, even though it is resolvable media.
    expect(
      resolvePreview("https://cdn.example.com/pic.png", allow),
    ).toBeUndefined();
  });

  it("gates on the effective host after a page→direct rewrite", () => {
    // imgur.com rewrites to i.imgur.com — listing the apex covers it via the
    // subdomain match, so the preview resolves to the direct host.
    expect(
      resolvePreview("https://imgur.com/aB3dE9f", ["imgur.com"]),
    ).toMatchObject({ src: "https://i.imgur.com/aB3dE9f.jpg", kind: "image" });
    // But a list that omits imgur entirely blocks it.
    expect(
      resolvePreview("https://imgur.com/aB3dE9f", ["xariah.net"]),
    ).toBeUndefined();
  });

  it("gates twimg format-param images on the allowlist too", () => {
    const href = "https://pbs.twimg.com/media/AbC123?format=jpg&name=large";
    expect(resolvePreview(href, ["pbs.twimg.com"])).toMatchObject({
      kind: "image",
      src: href,
    });
    expect(resolvePreview(href, ["imgur.com"])).toBeUndefined();
  });

  it("without an allowlist argument, skips the gate (resolver in isolation)", () => {
    expect(resolvePreview("https://cdn.example.com/pic.png")).toMatchObject({
      kind: "image",
    });
  });
});

describe("chip label + host", () => {
  it("labels by filename / last segment / host", () => {
    expect(chipLabel("https://i.imgur.com/abc.jpg")).toBe("abc.jpg");
    expect(chipLabel("https://example.com/foo/bar")).toBe("bar");
    expect(chipLabel("https://example.com/")).toBe("example.com");
  });

  it("extracts the host suffix", () => {
    expect(chipHost("https://i.imgur.com/abc.jpg")).toBe("i.imgur.com");
    expect(chipHost("garbage")).toBe("");
  });
});
