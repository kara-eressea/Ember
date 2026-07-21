import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { parseBBCode, type BBNode } from "./bbcode.js";
import { mdToBBCode } from "./markdown.js";

describe("mdToBBCode", () => {
  it("maps the COMPONENTS.md §7 inline set", () => {
    expect(mdToBBCode("**bold**")).toBe("[b]bold[/b]");
    expect(mdToBBCode("*italic*")).toBe("[i]italic[/i]");
    expect(mdToBBCode("~~gone~~")).toBe("[s]gone[/s]");
    expect(mdToBBCode("`code span`")).toBe("[noparse]code span[/noparse]");
    expect(mdToBBCode("[site](https://f-list.net)")).toBe(
      "[url=https://f-list.net]site[/url]",
    );
  });

  it("nests inline markup", () => {
    expect(mdToBBCode("**bold *and* italic**")).toBe(
      "[b]bold [i]and[/i] italic[/b]",
    );
    expect(mdToBBCode("[**bold link**](http://x.example)")).toBe(
      "[url=http://x.example][b]bold link[/b][/url]",
    );
  });

  it("respects flanking: no empty or space-adjacent emphasis", () => {
    expect(mdToBBCode("a ** b ** c")).toBe("a ** b ** c");
    expect(mdToBBCode("2 * 3 * 4")).toBe("2 * 3 * 4");
    expect(mdToBBCode("****")).toBe("****");
  });

  it("keeps unterminated markers literal", () => {
    expect(mdToBBCode("**dangling")).toBe("**dangling");
    expect(mdToBBCode("`unclosed")).toBe("`unclosed");
    expect(mdToBBCode("~~half")).toBe("~~half");
  });

  it("honors backslash escapes", () => {
    expect(mdToBBCode(String.raw`\*not italic\*`)).toBe("*not italic*");
    expect(mdToBBCode(String.raw`\**still not**`)).toBe("**still not**");
    expect(mdToBBCode(String.raw`a \\ b`)).toBe("a \\ b");
  });

  it("code spans win over emphasis inside them", () => {
    expect(mdToBBCode("`a *b* c`")).toBe("[noparse]a *b* c[/noparse]");
  });

  it("code spans bind tightest: closers inside them never match (audit)", () => {
    // An emphasis closer inside a span must not terminate the emphasis.
    expect(mdToBBCode("**a `b** c` d**")).toBe(
      "[b]a [noparse]b** c[/noparse] d[/b]",
    );
    // A BBCode closer inside a span must not terminate the passthrough.
    expect(mdToBBCode("[b]see `[/b]` done[/b]")).toBe(
      "[b]see [noparse][/b][/noparse] done[/b]",
    );
  });

  it("body-form [url] is raw-body passthrough (audit)", () => {
    // Markdown markers inside a literally-typed URL must survive untouched —
    // translating them would corrupt the href and destroy the link.
    expect(mdToBBCode("[url]http://a**b**c[/url]")).toBe(
      "[url]http://a**b**c[/url]",
    );
  });

  it("passes literally-typed BBCode through untouched", () => {
    // Raw-body tags: contents never Markdown-processed (milestone-4.md).
    expect(mdToBBCode("[eicon]tea*cup*[/eicon]")).toBe(
      "[eicon]tea*cup*[/eicon]",
    );
    expect(mdToBBCode("[noparse]**raw**[/noparse]")).toBe(
      "[noparse]**raw**[/noparse]",
    );
    expect(mdToBBCode("[user]Amber Vale[/user]")).toBe(
      "[user]Amber Vale[/user]",
    );
    // Wrapper/color/url tags pass through with their contents still
    // Markdown-processed.
    expect(mdToBBCode("[color=red]**warm**[/color]")).toBe(
      "[color=red][b]warm[/b][/color]",
    );
    expect(mdToBBCode("[b]already bbcode[/b]")).toBe("[b]already bbcode[/b]");
  });

  it("leaves markdown links with bad schemes literal", () => {
    expect(mdToBBCode("[x](javascript:alert(1))")).toBe(
      "[x](javascript:alert(1))",
    );
    expect(mdToBBCode("[x](ftp://files.example)")).toBe(
      "[x](ftp://files.example)",
    );
  });

  it("leaves /me and plain text alone", () => {
    expect(mdToBBCode("/me pours tea")).toBe("/me pours tea");
    expect(mdToBBCode("just words, no markup")).toBe("just words, no markup");
  });
});

// ── The milestone-4.md headline property ─────────────────────────────────────
// For arbitrary Markdown input, every tag in mdToBBCode() output is in the
// allowed subset.

const SUBSET = new Set([
  "b",
  "i",
  "u",
  "s",
  "sup",
  "sub",
  "color",
  "url",
  "user",
  "icon",
  "eicon",
  "noparse",
]);

function collectTags(nodes: readonly BBNode[], into: string[]): void {
  for (const node of nodes) {
    switch (node.type) {
      case "wrapper":
        into.push(node.tag);
        collectTags(node.children, into);
        break;
      case "color":
      case "url":
        into.push(node.type);
        collectTags(node.children, into);
        break;
      case "name":
        into.push(node.tag);
        break;
      case "noparse":
        into.push("noparse");
        break;
      case "text":
        break;
    }
  }
}

/** Markdown-ish soup: plain text, markers, links, and literal BBCode. */
const mdFragment = fc.oneof(
  fc.string({ maxLength: 10 }),
  fc.constantFrom(
    "**",
    "*",
    "~~",
    "`",
    "\\*",
    "[",
    "]",
    "(",
    ")",
    "[link](https://x.example)",
    "[x](javascript:alert(1))",
    "[b]",
    "[/b]",
    "[eicon]cup[/eicon]",
    "[color=red]",
    "[/color]",
    "[unknown]",
    "/me ",
    "text with spaces",
  ),
);
const mdInput = fc
  .array(mdFragment, { maxLength: 24 })
  .map((parts) => parts.join(""));

describe("subset invariant", () => {
  it("never emits a tag outside the F-Chat subset, never throws", () => {
    fc.assert(
      fc.property(mdInput, (input) => {
        const bbcode = mdToBBCode(input);
        const tags: string[] = [];
        collectTags(parseBBCode(bbcode), tags);
        expect(tags.every((tag) => SUBSET.has(tag))).toBe(true);
      }),
      { numRuns: 1000 },
    );
  });

  it("plain prose is untouched", () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 60 }).filter((s) => !/[*`~\\[\]]/.test(s)),
        (input) => {
          expect(mdToBBCode(input)).toBe(input);
        },
      ),
    );
  });
});

describe("spoiler ||…||", () => {
  it("passes the pipes through — plain text on the wire, never a tag", () => {
    expect(mdToBBCode("||secret||")).toBe("||secret||");
    expect(mdToBBCode("a ||secret|| b")).toBe("a ||secret|| b");
  });

  it("translates the covered contents like any run", () => {
    expect(mdToBBCode("||**loud** secret||")).toBe("||[b]loud[/b] secret||");
    expect(mdToBBCode("**||nested||**")).toBe("[b]||nested||[/b]");
  });

  it("round-trips: the wire form re-translates to itself", () => {
    const wire = mdToBBCode("||[b]x[/b] *y*||");
    expect(wire).toBe("||[b]x[/b] [i]y[/i]||");
    expect(mdToBBCode(wire)).toBe(wire);
  });

  it("unterminated or empty pipes stay literal", () => {
    expect(mdToBBCode("||half")).toBe("||half");
    expect(mdToBBCode("a || b || c")).toBe("a || b || c");
  });

  it("escaped pipes stay literal", () => {
    expect(mdToBBCode("\\||not a spoiler\\||")).toBe("||not a spoiler||");
  });

  it("pipes inside a code span never open a spoiler", () => {
    expect(mdToBBCode("`||raw||`")).toBe("[noparse]||raw||[/noparse]");
  });
});
