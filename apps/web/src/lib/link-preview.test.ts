import { describe, expect, it } from "vitest";
import { chipHost, chipLabel, resolvePreview } from "./link-preview.js";

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
