import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  BB_COLORS,
  BB_NAME_TAGS,
  BB_WRAPPER_TAGS,
  bbcodeToText,
  parseBBCode,
  sanitizeBBCode,
  serializeBBCode,
  type BBNode,
} from "./bbcode.js";

describe("parseBBCode", () => {
  it("parses the plain wrappers, nested", () => {
    expect(parseBBCode("a[b]bold [i]both[/i][/b] z")).toEqual([
      { type: "text", text: "a" },
      {
        type: "wrapper",
        tag: "b",
        children: [
          { type: "text", text: "bold " },
          {
            type: "wrapper",
            tag: "i",
            children: [{ type: "text", text: "both" }],
          },
        ],
      },
      { type: "text", text: " z" },
    ]);
  });

  it("is case-insensitive and canonicalizes on serialize", () => {
    expect(sanitizeBBCode("[B]x[/B][COLOR=Red]y[/COLOR]")).toBe(
      "[b]x[/b][color=red]y[/color]",
    );
  });

  it("parses color only from the fixed list", () => {
    expect(parseBBCode("[color=cyan]x[/color]")).toEqual([
      { type: "color", color: "cyan", children: [{ type: "text", text: "x" }] },
    ]);
    // Hex and arbitrary values are literal text — F-Chat rejects them.
    expect(sanitizeBBCode("[color=#ff0000]x[/color]")).toBe(
      "[color=#ff0000]x[/color]",
    );
    expect(parseBBCode("[color=#ff0000]x[/color]")[0]).toMatchObject({
      type: "text",
    });
  });

  it("parses both url forms and requires the scheme", () => {
    expect(parseBBCode("[url=https://f-list.net]site[/url]")).toEqual([
      {
        type: "url",
        href: "https://f-list.net",
        children: [{ type: "text", text: "site" }],
      },
    ]);
    expect(parseBBCode("[url]http://example.com/a?b=1[/url]")).toEqual([
      {
        type: "url",
        href: "http://example.com/a?b=1",
        children: [{ type: "text", text: "http://example.com/a?b=1" }],
      },
    ]);
    // "The 'http://' part is REQUIRED or it will fail as a bad URL."
    expect(parseBBCode("[url]www.example.com[/url]")[0]).toMatchObject({
      type: "text",
    });
    expect(parseBBCode("[url=javascript:alert(1)]x[/url]")[0]).toMatchObject({
      type: "text",
    });
  });

  it("parses name tags with the F-List charset, body never markup", () => {
    expect(parseBBCode("[user]Amber Vale[/user]")).toEqual([
      { type: "name", tag: "user", name: "Amber Vale" },
    ]);
    expect(parseBBCode("[eicon]tea.time-2[/eicon]")).toEqual([
      { type: "name", tag: "eicon", name: "tea.time-2" },
    ]);
    // A [b] inside is not a valid name → the whole thing stays literal.
    expect(parseBBCode("[icon][b]x[/b][/icon]")[0]).toMatchObject({
      type: "text",
    });
  });

  it("a closer with a parameter literalizes instead of dropping it", () => {
    // [/b=oops] is officially meaningless — the whole run stays visible.
    expect(sanitizeBBCode("[b]x[/b=oops]")).toBe("[b]x[/b=oops]");
    expect(parseBBCode("[b]x[/b=oops]").every((n) => n.type === "text")).toBe(
      true,
    );
  });

  it("body-form url hrefs containing ']' serialize back to body form", () => {
    // Param position would truncate the href at the ']' and silently change
    // the link target on re-parse (audit): the sanitize fixpoint must hold
    // at the AST level, not just the string level.
    const tricky = "[url]http://a.example]x[/url]";
    expect(sanitizeBBCode(tricky)).toBe(tricky);
    expect(parseBBCode(sanitizeBBCode(tricky))).toEqual(parseBBCode(tricky));
  });

  it("noparse swallows tags literally", () => {
    expect(parseBBCode("[noparse][b]x[/b][/noparse]")).toEqual([
      { type: "noparse", text: "[b]x[/b]" },
    ]);
  });

  it("literalizes unknown tags, stray closers, and unclosed openers", () => {
    expect(sanitizeBBCode("[big]x[/big]")).toBe("[big]x[/big]");
    expect(parseBBCode("[big]x[/big]").every((n) => n.type === "text")).toBe(
      true,
    );
    expect(sanitizeBBCode("a[/b]z")).toBe("a[/b]z");
    expect(sanitizeBBCode("[b]never closed")).toBe("[b]never closed");
    expect(sanitizeBBCode("[b][i]x[/b]")).toBe("[b][i]x[/b]");
    expect(sanitizeBBCode("plain [ bracket")).toBe("plain [ bracket");
  });

  it("parses [spoiler] in every dialect, nesting subset markup (#204)", () => {
    expect(parseBBCode("hush [spoiler]the [b]butler[/b][/spoiler]!")).toEqual([
      { type: "text", text: "hush " },
      {
        type: "spoiler",
        children: [
          { type: "text", text: "the " },
          {
            type: "wrapper",
            tag: "b",
            children: [{ type: "text", text: "butler" }],
          },
        ],
      },
      { type: "text", text: "!" },
    ]);
    // Wraps an eicon just as well (the QA screenshot case).
    expect(parseBBCode("[spoiler][eicon]boop[/eicon][/spoiler]")).toEqual([
      {
        type: "spoiler",
        children: [{ type: "name", tag: "eicon", name: "boop" }],
      },
    ]);
    // Available under the profile dialect too.
    expect(parseBBCode("[spoiler]x[/spoiler]", "profile")).toEqual([
      { type: "spoiler", children: [{ type: "text", text: "x" }] },
    ]);
  });

  it("[spoiler] with a parameter or unclosed stays literal (#204)", () => {
    expect(sanitizeBBCode("[spoiler=hint]x[/spoiler]")).toBe(
      "[spoiler=hint]x[/spoiler]",
    );
    expect(sanitizeBBCode("[spoiler]never closed")).toBe(
      "[spoiler]never closed",
    );
  });

  it("round-trips [spoiler] and flattens it to visible text (#204)", () => {
    const input = "[spoiler]the [b]butler[/b] did it[/spoiler]";
    expect(sanitizeBBCode(input)).toBe(input);
    expect(bbcodeToText(input)).toBe("the butler did it");
  });

  it("never throws on hostile input", () => {
    fc.assert(
      fc.property(fc.string(), (input) => {
        expect(() => sanitizeBBCode(input)).not.toThrow();
      }),
    );
  });
});

// ── Property: BBCode → AST → BBCode is a fixpoint ───────────────────────────

/** Generator biased toward tag-shaped input: fragments glued together. */
const bbFragment = fc.oneof(
  fc.string({ maxLength: 8 }),
  fc.constantFrom(
    ...BB_WRAPPER_TAGS.flatMap((t) => [`[${t}]`, `[/${t}]`]),
    ...BB_COLORS.map((c) => `[color=${c}]`),
    "[/color]",
    "[url=https://x.example]",
    "[url]",
    "[/url]",
    ...BB_NAME_TAGS.flatMap((t) => [`[${t}]`, `[/${t}]`]),
    "[noparse]",
    "[/noparse]",
    "[unknown]",
    "[color=nope]",
    "name text",
    "http://a.example",
    "[",
    "]",
  ),
);
const bbInput = fc
  .array(bbFragment, { maxLength: 24 })
  .map((parts) => parts.join(""));

function collectTags(nodes: readonly BBNode[], into: string[]): void {
  for (const node of nodes) {
    switch (node.type) {
      case "wrapper":
        into.push(node.tag);
        collectTags(node.children, into);
        break;
      case "color":
        into.push("color");
        collectTags(node.children, into);
        break;
      case "url":
        into.push("url");
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

const SUBSET = new Set([
  ...BB_WRAPPER_TAGS,
  "color",
  "url",
  ...BB_NAME_TAGS,
  "noparse",
]);

describe("round-trip properties", () => {
  it("serialize(parse(s)) is a parse fixpoint", () => {
    fc.assert(
      fc.property(bbInput, (input) => {
        const once = sanitizeBBCode(input);
        expect(sanitizeBBCode(once)).toBe(once);
        expect(parseBBCode(once)).toEqual(parseBBCode(sanitizeBBCode(once)));
      }),
      { numRuns: 500 },
    );
  });

  it("the AST only ever holds subset tags", () => {
    fc.assert(
      fc.property(bbInput, (input) => {
        const tags: string[] = [];
        collectTags(parseBBCode(input), tags);
        expect(tags.every((tag) => SUBSET.has(tag))).toBe(true);
      }),
      { numRuns: 500 },
    );
  });

  it("well-formed subset markup round-trips byte-identical", () => {
    const wellFormed =
      "[b]a[/b][i]b[/i][u]c[/u][s]d[/s][sup]e[/sup][sub]f[/sub]" +
      "[color=red]g[/color][url=https://x.example]h[/url]" +
      "[user]Nyx Firemane[/user][icon]Tally Marsh[/icon]" +
      "[eicon]teacup[/eicon][noparse][b]raw[/b][/noparse]";
    expect(sanitizeBBCode(wellFormed)).toBe(wellFormed);
  });
});

describe("profile dialect (M8)", () => {
  it("parses profile blocks that stay literal on the chat wire", () => {
    const input = "[heading]About[/heading][quote]said[/quote]";
    expect(parseBBCode(input, "profile")).toEqual([
      {
        type: "block",
        tag: "heading",
        children: [{ type: "text", text: "About" }],
      },
      {
        type: "block",
        tag: "quote",
        children: [{ type: "text", text: "said" }],
      },
    ]);
    // Chat dialect: same input is inert literal text.
    expect(parseBBCode(input)).toEqual([{ type: "text", text: input }]);
  });

  it("parses collapse with and without a title, and void [hr]", () => {
    expect(parseBBCode("[collapse=Story]body[/collapse]", "profile")).toEqual([
      {
        type: "collapse",
        title: "Story",
        children: [{ type: "text", text: "body" }],
      },
    ]);
    expect(parseBBCode("[collapse]x[/collapse][hr]", "profile")).toEqual([
      { type: "collapse", title: "", children: [{ type: "text", text: "x" }] },
      { type: "hr" },
    ]);
  });

  it("nests chat-subset tags inside profile blocks", () => {
    expect(parseBBCode("[center][b]hi[/b][/center]", "profile")).toEqual([
      {
        type: "block",
        tag: "center",
        children: [
          {
            type: "wrapper",
            tag: "b",
            children: [{ type: "text", text: "hi" }],
          },
        ],
      },
    ]);
  });

  it("degrades unknown tags and unclosed blocks to literal text", () => {
    expect(parseBBCode("[fancy]x[/fancy]", "profile")).toEqual([
      { type: "text", text: "[fancy]x[/fancy]" },
    ]);
    expect(parseBBCode("[heading]dangling", "profile")).toEqual([
      { type: "text", text: "[heading]dangling" },
    ]);
  });

  it("round-trips profile nodes through the serializer", () => {
    const input =
      "[collapse=Deep Story][center][b]hi[/b][/center][hr][/collapse]";
    expect(serializeBBCode(parseBBCode(input, "profile"))).toBe(input);
  });

  it("parses [img] with an inline id, a URL, and the alt form (#212)", () => {
    expect(parseBBCode("[img]90101[/img]", "profile")).toEqual([
      { type: "img", src: "90101", alt: "" },
    ]);
    expect(
      parseBBCode("[img]https://static.f-list.net/a/b/c.png[/img]", "profile"),
    ).toEqual([
      { type: "img", src: "https://static.f-list.net/a/b/c.png", alt: "" },
    ]);
    expect(parseBBCode("[img=90101]Me by the river[/img]", "profile")).toEqual([
      { type: "img", src: "90101", alt: "Me by the river" },
    ]);
  });

  it("keeps [img] literal on the chat wire and when empty/unclosed", () => {
    expect(parseBBCode("[img]90101[/img]")).toEqual([
      { type: "text", text: "[img]90101[/img]" },
    ]);
    // Unclosed opener and empty body both degrade to literal text.
    expect(parseBBCode("[img]dangling", "profile")).toEqual([
      { type: "text", text: "[img]dangling" },
    ]);
    expect(parseBBCode("[img][/img]", "profile")).toEqual([
      { type: "text", text: "[img][/img]" },
    ]);
  });

  it("round-trips [img] nodes through the serializer", () => {
    for (const input of [
      "[img]90101[/img]",
      "[img=90101]Me by the river[/img]",
    ]) {
      expect(serializeBBCode(parseBBCode(input, "profile"))).toBe(input);
    }
  });
});

describe("bbcodeToText", () => {
  it("strips wrappers and colour to their visible text", () => {
    expect(bbcodeToText("[b]Looking[/b] for [color=red]fun[/color]")).toBe(
      "Looking for fun",
    );
  });

  it("keeps the link text, never the raw tag or href", () => {
    expect(bbcodeToText("see [url=https://x.example]my ad[/url] now")).toBe(
      "see my ad now",
    );
    expect(bbcodeToText("[url]https://x.example[/url]")).toBe(
      "https://x.example",
    );
  });

  it("keeps user references but drops decorative icons", () => {
    expect(bbcodeToText("poke [user]Nyx Vale[/user] hi")).toBe(
      "poke Nyx Vale hi",
    );
    expect(bbcodeToText("mood [eicon]sparkle[/eicon] today")).toBe(
      "mood today",
    );
  });

  it("collapses whitespace to a single trimmed line", () => {
    expect(bbcodeToText("  busy\n\n  now  ")).toBe("busy now");
  });

  it("leaves malformed tags as the literal text the parser produced", () => {
    expect(bbcodeToText("[b]unclosed and [fancy]x[/fancy]")).toBe(
      "[b]unclosed and [fancy]x[/fancy]",
    );
  });
});
