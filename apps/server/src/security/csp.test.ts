import { describe, expect, it } from "vitest";
import { DEFAULT_IMAGE_PREVIEW_HOSTS } from "@emberchat/protocol";
import { contentSecurityDirectives, mediaHostSources } from "./csp.js";

describe("contentSecurityDirectives (#335)", () => {
  const directives = contentSecurityDirectives();

  it("permits the Discord CDN and twimg image hosts the client previews", () => {
    // The reported failure: these were blocked by img-src while f-list worked.
    const imgSrc = directives["img-src"];
    expect(imgSrc).toContain("https://cdn.discordapp.com");
    expect(imgSrc).toContain("https://media.discordapp.net");
    expect(imgSrc).toContain("https://pbs.twimg.com");
  });

  it("still permits f-list static avatars/eicons and inline data URIs", () => {
    const imgSrc = directives["img-src"];
    expect(imgSrc).toContain("https://static.f-list.net");
    expect(imgSrc).toContain("'self'");
    expect(imgSrc).toContain("data:");
  });

  it("mirrors every default preview host so shipped defaults just work", () => {
    for (const host of DEFAULT_IMAGE_PREVIEW_HOSTS) {
      expect(directives["img-src"]).toContain(`https://${host}`);
    }
  });

  it("permits the same hosts for <video> previews via media-src", () => {
    const mediaSrc = directives["media-src"];
    expect(mediaSrc).toContain("'self'");
    expect(mediaSrc).toContain("https://cdn.discordapp.com");
    expect(mediaSrc).toEqual(expect.arrayContaining(mediaHostSources()));
  });

  it("keeps scripts and framing locked down", () => {
    expect(directives["script-src"]).toEqual(["'self'"]);
    expect(directives["frame-ancestors"]).toEqual(["'none'"]);
    expect(directives["object-src"]).toEqual(["'none'"]);
  });
});

describe("mediaHostSources", () => {
  it("prefixes every default host with the https scheme", () => {
    for (const source of mediaHostSources()) {
      expect(source).toMatch(/^https:\/\/[a-z0-9.-]+$/);
    }
  });
});
