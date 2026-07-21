import { describe, expect, it } from "vitest";
import { parseCharacterUrl } from "./character-url.js";

describe("parseCharacterUrl", () => {
  it("parses the canonical character URL", () => {
    expect(parseCharacterUrl("https://www.f-list.net/c/Kira")).toBe("Kira");
  });

  it("accepts the www-less host", () => {
    expect(parseCharacterUrl("https://f-list.net/c/Kira")).toBe("Kira");
  });

  it("accepts http as well as https", () => {
    expect(parseCharacterUrl("http://www.f-list.net/c/Kira")).toBe("Kira");
  });

  it("is case-insensitive on the host", () => {
    expect(parseCharacterUrl("https://WWW.F-List.net/c/Kira")).toBe("Kira");
  });

  it("tolerates a trailing slash", () => {
    expect(parseCharacterUrl("https://www.f-list.net/c/Kira/")).toBe("Kira");
  });

  it("URL-decodes names with spaces (%20)", () => {
    expect(parseCharacterUrl("https://www.f-list.net/c/Some%20Name")).toBe(
      "Some Name",
    );
  });

  it("URL-decodes other encoded characters", () => {
    expect(parseCharacterUrl("https://www.f-list.net/c/A%26B")).toBe("A&B");
  });

  it("preserves the name's original casing", () => {
    expect(parseCharacterUrl("https://www.f-list.net/c/lowercase")).toBe(
      "lowercase",
    );
  });

  it("ignores query strings and fragments", () => {
    expect(parseCharacterUrl("https://www.f-list.net/c/Kira?x=1#frag")).toBe(
      "Kira",
    );
  });

  it("rejects non-character f-list.net paths", () => {
    expect(parseCharacterUrl("https://www.f-list.net/")).toBeUndefined();
    expect(parseCharacterUrl("https://www.f-list.net/p/12345")).toBeUndefined();
    expect(
      parseCharacterUrl("https://www.f-list.net/c/Kira/friends"),
    ).toBeUndefined();
  });

  it("rejects an empty name", () => {
    expect(parseCharacterUrl("https://www.f-list.net/c/")).toBeUndefined();
  });

  it("rejects other hosts", () => {
    expect(parseCharacterUrl("https://example.com/c/Kira")).toBeUndefined();
    expect(
      parseCharacterUrl("https://static.f-list.net/c/Kira"),
    ).toBeUndefined();
    expect(parseCharacterUrl("https://evil-f-list.net/c/Kira")).toBeUndefined();
  });

  it("rejects non-http(s) protocols", () => {
    expect(
      parseCharacterUrl("javascript:alert(1)//f-list.net/c/Kira"),
    ).toBeUndefined();
  });

  it("returns undefined for malformed input", () => {
    expect(parseCharacterUrl("not a url")).toBeUndefined();
    expect(parseCharacterUrl("")).toBeUndefined();
  });

  it("returns undefined for malformed percent-encoding", () => {
    expect(parseCharacterUrl("https://www.f-list.net/c/%E0%A4%A")).toBe(
      undefined,
    );
  });
});
