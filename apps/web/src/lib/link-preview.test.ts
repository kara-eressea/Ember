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
