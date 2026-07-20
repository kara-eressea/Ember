import { describe, expect, it } from "vitest";
import { analyzeMarkdown } from "./lossiness.js";
import { mdToBBCode } from "./markdown.js";

const kinds = (markdown: string) =>
  analyzeMarkdown(markdown).map((d) => d.kind);

describe("analyzeMarkdown — clean inputs", () => {
  it("reports nothing for plain prose and fully supported Markdown", () => {
    expect(analyzeMarkdown("hello there")).toEqual([]);
    expect(
      analyzeMarkdown("**bold** *italic* ~~gone~~ `code` [link](https://x.y)"),
    ).toEqual([]);
    expect(analyzeMarkdown("[b]bold[/b] [color=red]r[/color]")).toEqual([]);
    expect(analyzeMarkdown("")).toEqual([]);
  });

  it("never flags arithmetic asterisks or snake_case", () => {
    expect(analyzeMarkdown("5*3 is 15 and foo_bar_baz is a name")).toEqual([]);
  });

  it("never flags prose brackets or unknown tags", () => {
    expect(analyzeMarkdown("[sighs] a [very unknown] aside")).toEqual([]);
  });
});

describe("analyzeMarkdown — block constructs", () => {
  it("flags headings, lists, quotes, fences, and rules with offsets", () => {
    const md = "# Title\n- item\n> quote\n```\ncode\n```\n---";
    const diags = analyzeMarkdown(md);
    expect(diags.map((d) => d.kind)).toEqual([
      "unsupported-block",
      "unsupported-block",
      "unsupported-block",
      "unsupported-block",
      "unsupported-block",
      "unsupported-block",
    ]);
    expect(diags[0]).toMatchObject({ at: 0, snippet: "#" });
    expect(diags[1]).toMatchObject({ at: 8, snippet: "-" });
    expect(md.slice(diags[2]!.at, diags[2]!.at + 1)).toBe(">");
  });

  it("does not flag mid-line markers or indented-by-4 text", () => {
    expect(kinds("see #channel and things - like this")).toEqual([]);
    expect(kinds("    # not a heading at 4 spaces")).toEqual([]);
  });
});

describe("analyzeMarkdown — underscore emphasis", () => {
  it("flags _italic_ and __bold__ at word boundaries", () => {
    const diags = analyzeMarkdown("this is _important_ and __very much__ so");
    expect(diags.map((d) => d.kind)).toEqual([
      "underscore-emphasis",
      "underscore-emphasis",
    ]);
    expect(diags[0]!.snippet).toBe("_important_");
    expect(diags[1]!.snippet).toBe("__very much__");
  });

  it("ignores unclosed or mid-word underscores", () => {
    expect(kinds("a _dangling thing")).toEqual([]);
    expect(kinds("file_name_here.txt")).toEqual([]);
  });
});

describe("analyzeMarkdown — inline translator reports", () => {
  it("flags unterminated ** / ~~ / word-start *", () => {
    expect(kinds("a **bold that never ends")).toEqual([
      "unterminated-emphasis",
    ]);
    expect(kinds("a ~~strike that never ends")).toEqual([
      "unterminated-emphasis",
    ]);
    expect(kinds("see *this")).toEqual(["unterminated-emphasis"]);
  });

  it("flags unterminated and misparameterized subset BBCode", () => {
    expect(kinds("[b]never closed")).toEqual(["unterminated-bbcode"]);
    expect(kinds("[noparse]never closed")).toEqual(["unterminated-bbcode"]);
    expect(kinds("[color=notacolor]x[/color]")).toEqual([
      "invalid-bbcode-param",
    ]);
    expect(kinds("[color]x[/color]")).toEqual(["invalid-bbcode-param"]);
    expect(kinds("[b=weird]x[/b]")).toEqual(["invalid-bbcode-param"]);
    expect(kinds("[url=ftp://nope]x[/url]")).toEqual(["invalid-bbcode-param"]);
  });

  it("reports absolute offsets from inside nested constructs", () => {
    const md = "[b]outer **inner[/b]";
    const diags = analyzeMarkdown(md);
    expect(diags).toHaveLength(1);
    expect(diags[0]!.kind).toBe("unterminated-emphasis");
    expect(md.slice(diags[0]!.at, diags[0]!.at + 2)).toBe("**");
  });
});

describe("analyzeMarkdown — foreign BBCode", () => {
  it("flags known non-chat tags but not their closers", () => {
    const diags = analyzeMarkdown("[center]hi[/center] and [img=1]x[/img]");
    expect(diags.map((d) => d.kind)).toEqual([
      "unsupported-bbcode",
      "unsupported-bbcode",
    ]);
    expect(diags[0]!.snippet).toBe("[center]");
    expect(diags[1]!.snippet).toBe("[img=1]");
  });
});

describe("analyzeMarkdown — masked regions", () => {
  it("reports nothing from inside code spans or noparse", () => {
    expect(kinds("`[center] _lit_ **x`")).toEqual([]);
    expect(kinds("[noparse][center] _lit_ # x[/noparse]")).toEqual([]);
  });
});

describe("analyzeMarkdown — invariants", () => {
  it("never changes what mdToBBCode produces", () => {
    const samples = [
      "# Title\n**bold** _under_ [center]x[/center] `code` 5*3",
      "[b]outer **inner[/b] ~~dangling",
      "[noparse][heading]raw[/heading][/noparse] [color]x[/color]",
    ];
    for (const md of samples) {
      const before = mdToBBCode(md);
      analyzeMarkdown(md);
      expect(mdToBBCode(md)).toBe(before);
    }
  });
});
