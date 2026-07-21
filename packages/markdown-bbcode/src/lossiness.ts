// M10 step 4: the lossiness report. Markdown the composer can't translate
// into the chat BBCode subset reaches the wire as literal text — honest,
// but surprising to anyone expecting full Markdown. analyzeMarkdown()
// returns the spots where what-you-typed won't be what-they-see, for the
// composer and ad editor to surface as warnings.
//
// Two sources, no mirror engines:
//  - Inline constructs come from the translator's own walk (markdown.ts
//    threads a reporter through translate) — the exact failure points, by
//    construction in sync with what actually translates.
//  - Block-level constructs (headings, lists, quotes, fences, rules), the
//    underscore-emphasis dialect gap, and known-foreign BBCode tags are
//    scanned here: the inline translator never looks at them at all.
//
// Diagnostics are advisory: they must never block a send, and this module
// never throws.

import {
  BB_BLOCK_TAGS,
  BB_NAME_TAGS,
  BB_WRAPPER_TAGS,
  makeCloserFinder,
  readTagToken,
} from "./bbcode.js";
import { maskCodeSpans, translateReporting } from "./markdown.js";

export type MdLossKind =
  /** A line-level Markdown construct with no BBCode equivalent —
   * heading, list item, blockquote, fence, thematic break. */
  | "unsupported-block"
  /** `_emphasis_` — this dialect only formats `*`/`**`/`~~`. */
  | "underscore-emphasis"
  /** A BBCode tag users plausibly know (profile dialect, other
   * platforms) that the chat wire renders as literal text. */
  | "unsupported-bbcode"
  /** A subset tag that literalized over its parameter — [b=x],
   * [color=notacolor], [url=badhref], [color] with no param. */
  | "invalid-bbcode-param"
  /** A subset tag with no matching closer. */
  | "unterminated-bbcode"
  /** An emphasis opener (`**`, `~~`, word-start `*`) with no closer. */
  | "unterminated-emphasis";

export interface MdLossDiagnostic {
  readonly kind: MdLossKind;
  /** Character offset into the source Markdown. */
  readonly at: number;
  /** The construct that stays literal, capped for display. */
  readonly snippet: string;
}

export type MdLossReporter = (
  kind: MdLossKind,
  at: number,
  snippet: string,
) => void;

/** Longest snippet a diagnostic carries — enough to recognize, never a
 * whole paragraph. */
const SNIPPET_CAP = 40;

/** Tags outside the chat subset that users plausibly type expecting them
 * to render: the profile block dialect plus common F-List/forum tags. A
 * random `[bracketed aside]` is prose, not BBCode — only known names
 * warn. */
const FOREIGN_TAGS = new Set<string>([
  ...BB_BLOCK_TAGS,
  "collapse",
  "hr",
  "img",
  "session",
  "channel",
  // [spoiler] the tag stays foreign — `||…||` is the supported spelling
  // (markdown.ts translates it; the pipes ride the wire as plain text).
  "spoiler",
  "code",
]);

const CHAT_TAGS = new Set<string>([
  ...BB_WRAPPER_TAGS,
  ...BB_NAME_TAGS,
  "color",
  "url",
  "noparse",
]);

/** Line-level Markdown with no chat-BBCode equivalent. Group 1 is the
 * marker: ATX heading, blockquote, list item, fence, thematic break. */
const BLOCK_LINE =
  /^ {0,3}(#{1,6} |> |(?:[-*+]|\d{1,9}[.)]) |`{3}|~{3}|(?:-{3,}|\*{3,}|_{3,})[ \t]*$)/;

const CLOSER_BOUNDARY = /[\s).,!?;:]/;

function cap(snippet: string): string {
  return snippet.length <= SNIPPET_CAP
    ? snippet
    : `${snippet.slice(0, SNIPPET_CAP - 1)}…`;
}

/** NULs every complete [noparse]…[/noparse] span (tags included) so the
 * scans below never warn about deliberately-literal text. Spans are found
 * on the input as given; NUL padding keeps every offset stable. */
function maskNoparse(input: string): string {
  const lower = input.toLowerCase();
  if (!lower.includes("[noparse]")) {
    return input;
  }
  const findClose = makeCloserFinder(lower);
  let out = "";
  let at = 0;
  while (at < input.length) {
    const open = lower.indexOf("[noparse]", at);
    if (open === -1) {
      out += input.slice(at);
      break;
    }
    const bodyStart = open + "[noparse]".length;
    const close = findClose("noparse", bodyStart);
    if (close === -1) {
      out += input.slice(at, bodyStart);
      at = bodyStart;
      continue;
    }
    const end = close + "[/noparse]".length;
    out += input.slice(at, open) + "\0".repeat(end - open);
    at = end;
  }
  return out;
}

/**
 * Every place where the given Markdown reaches the wire as something
 * other than what a Markdown-literate author expects, sorted by offset.
 * Advisory only — never blocks a send, never throws.
 */
export function analyzeMarkdown(markdown: string): MdLossDiagnostic[] {
  const diags: MdLossDiagnostic[] = [];
  const report: MdLossReporter = (kind, at, snippet) => {
    diags.push({ kind, at, snippet: cap(snippet) });
  };

  // 1. Inline constructs: the translator's own walk.
  translateReporting(markdown, report);

  // 2. Block-level lines. Scanned with noparse masked but backticks
  //    intact — fences ARE backticks, masking them would hide the thing
  //    being reported.
  const noparseMasked = maskNoparse(markdown);
  let offset = 0;
  for (const line of noparseMasked.split("\n")) {
    const match = BLOCK_LINE.exec(line);
    if (match) {
      const markerStart = match[0].length - match[1]!.length;
      report(
        "unsupported-block",
        offset + markerStart,
        match[1]!.trimEnd() || match[1]!,
      );
    }
    offset += line.length + 1;
  }

  // 3. Underscore emphasis and foreign BBCode tags, with code spans
  //    masked too — inside a span both are deliberately literal.
  const masked = maskCodeSpans(noparseMasked);
  scanUnderscoreEmphasis(masked, report);
  scanForeignTags(masked, report);

  diags.sort((a, b) => a.at - b.at || a.kind.localeCompare(b.kind));
  return diags;
}

/** `_x_` / `__x__` with CommonMark-ish word-boundary flanking: opener at
 * start/space/paren before a non-space, closer after a non-space and
 * before end/space/punctuation. `snake_case` never matches — its
 * underscores sit mid-word. */
function scanUnderscoreEmphasis(text: string, report: MdLossReporter): void {
  const opener = /(^|[\s(])(_{1,2})(?=\S)/g;
  let match;
  while ((match = opener.exec(text)) !== null) {
    const delim = match[2]!;
    const start = match.index + match[1]!.length;
    let at = start + delim.length;
    let close = -1;
    while (at < text.length) {
      const index = text.indexOf(delim, at);
      if (index === -1) {
        break;
      }
      const before = text[index - 1]!;
      const after = text[index + delim.length];
      if (
        before !== " " &&
        before !== "_" &&
        (after === undefined || CLOSER_BOUNDARY.test(after)) &&
        index > start + delim.length - 1
      ) {
        close = index;
        break;
      }
      at = index + 1;
    }
    if (close !== -1) {
      report(
        "underscore-emphasis",
        start,
        text.slice(start, close + delim.length),
      );
      opener.lastIndex = close + delim.length;
    }
  }
}

/** Known-foreign BBCode openers ([center], [img=…]…): rendered as literal
 * text on the chat wire. Chat-subset tags are the translator's business;
 * unknown bracketed words are prose. */
function scanForeignTags(text: string, report: MdLossReporter): void {
  let at = 0;
  while ((at = text.indexOf("[", at)) !== -1) {
    const token = readTagToken(text, at);
    if (
      token &&
      !token.closing &&
      !CHAT_TAGS.has(token.tag) &&
      FOREIGN_TAGS.has(token.tag)
    ) {
      report("unsupported-bbcode", at, token.raw);
      at += token.length;
      continue;
    }
    at += 1;
  }
}
