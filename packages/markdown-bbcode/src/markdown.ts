// Markdown → F-Chat BBCode. The compose-side half of the M4 Markdown layer:
// the composer accepts the inline Markdown from ui/COMPONENTS.md §7 and the
// wire gets well-structured subset BBCode (developer policy — never emit a
// tag outside `b i u s sup sub color url user icon eicon noparse`).
//
// Mapping:
//   **bold**        → [b]bold[/b]
//   *italic*        → [i]italic[/i]
//   ~~strike~~      → [s]strike[/s]
//   ||spoiler||     → ||spoiler||           (client-only construct: the
//                     pipes ride the wire as plain characters — EmberChat
//                     renders a covered bar, every other client shows the
//                     literal ||text||; never a [spoiler] tag, which is
//                     outside the subset)
//   `code`          → [noparse]code[/noparse]   (F-Chat has no code tag;
//                     noparse keeps the span literal, the client renders it
//                     as code — official clients just show the text)
//   [text](http://…)→ [url=http://…]text[/url]
//   \* \` \~ \[ \| \\ → the literal character
//
// Code spans bind tightest: emphasis closers and BBCode closers inside a
// backtick span never match (the lookahead searches run over a masked copy
// of the input). BBCode typed literally passes through untouched
// (milestone-4.md): raw-body elements — [noparse], the name tags, and the
// body-form [url]…[/url] — verbatim; wrapper/color/[url=…] elements keep
// their contents Markdown-processed. Anything ambiguous or unterminated
// stays literal text; this function never throws.

import {
  makeCloserFinder,
  readTagToken,
  validHref,
  BB_COLORS,
} from "./bbcode.js";
import type { MdLossReporter } from "./lossiness.js";

const ESCAPABLE = new Set(["*", "`", "~", "[", "]", "\\", "(", "|"]);

/** Styled-range kinds the inline-composer highlighter renders. `delim`
 * covers the marker characters themselves (dimmed, never hidden). */
export type MdSpanType =
  | "bold"
  | "italic"
  | "strike"
  | "spoiler"
  | "code"
  | "eicon"
  | "delim";

/** A styled range over the *original markdown string* (absolute offsets). */
export interface MdSpan {
  from: number;
  to: number;
  type: MdSpanType;
}

const WRAPPER_TAGS = new Set(["b", "i", "u", "s", "sup", "sub"]);
/** Elements whose body is copied verbatim, never Markdown-processed. */
const RAW_BODY_TAGS = new Set(["noparse", "user", "icon", "eicon"]);

/**
 * A copy of `input` with every complete backtick span (backticks included)
 * replaced by NUL padding of the same length. Lookahead searches (emphasis
 * closers, BBCode closers) run over this copy, so nothing inside a code
 * span can ever terminate an outer construct — positions map 1:1 back to
 * the original.
 */
export function maskCodeSpans(input: string): string {
  if (!input.includes("`")) {
    return input;
  }
  let out = "";
  let at = 0;
  while (at < input.length) {
    const open = input.indexOf("`", at);
    if (open === -1) {
      out += input.slice(at);
      break;
    }
    const close = input.indexOf("`", open + 1);
    if (close === -1 || close === open + 1) {
      // Unterminated or empty: not a span, the backtick stays literal.
      out += input.slice(at, open + 1);
      at = open + 1;
      continue;
    }
    out += input.slice(at, open) + "\0".repeat(close - open + 1);
    at = close + 1;
  }
  return out;
}

/**
 * Finds the closing run of `delimiter` after `from` with CommonMark-ish
 * flanking: the opener must be followed by non-space, the closer preceded
 * by non-space. Runs over the masked string, so a closer inside a code
 * span never matches. Returns the index of the closer, or undefined.
 */
function findDelimiter(
  masked: string,
  from: number,
  delimiter: string,
): number | undefined {
  if (from >= masked.length || masked[from] === " ") {
    return undefined;
  }
  let at = from;
  while (at < masked.length) {
    const index = masked.indexOf(delimiter, at);
    if (index === -1) {
      return undefined;
    }
    if (
      index > from &&
      masked[index - 1] !== " " &&
      masked[index - 1] !== "\\"
    ) {
      return index;
    }
    at = index + 1;
  }
  return undefined;
}

/**
 * Translates one Markdown string (a message body) into subset BBCode.
 * Inline only — fenced code blocks are a render concern (COMPONENTS.md §6),
 * on the wire they are just literal backticked text.
 */
export function mdToBBCode(markdown: string): string {
  return translate(markdown);
}

/**
 * The M10 lossiness hook: translation with the walk's own failure points
 * reported (unterminated emphasis/BBCode, invalid params). The translator
 * IS the diagnostic engine for inline constructs — no mirror matcher to
 * drift (analyzeMarkdown in lossiness.ts adds the block-level scans the
 * inline walk never sees).
 */
export function translateReporting(
  input: string,
  report: MdLossReporter,
): string {
  return translate(input, report);
}

/**
 * The composer's inline-highlight ranges for `input`, sorted by position.
 * This IS the translator: the same walk that produces the wire BBCode emits
 * the spans, so what renders styled in the input and what actually
 * translates can never disagree (#226). Nested emphasis yields overlapping
 * spans (`**a *b* c**` → bold over the run, italic inside).
 */
export function markdownSpans(input: string): MdSpan[] {
  const spans: MdSpan[] = [];
  translate(input, undefined, 0, spans);
  return spans.sort((a, b) => a.from - b.from || a.to - b.to);
}

function translate(
  input: string,
  report?: MdLossReporter,
  base = 0,
  spans?: MdSpan[],
): string {
  let out = "";
  let at = 0;
  const masked = maskCodeSpans(input);
  const findClose = makeCloserFinder(masked.toLowerCase());
  const mark = (from: number, to: number, type: MdSpanType) => {
    spans?.push({ from: base + from, to: base + to, type });
  };

  while (at < input.length) {
    const ch = input[at]!;

    // Backslash escapes.
    if (ch === "\\" && at + 1 < input.length && ESCAPABLE.has(input[at + 1]!)) {
      out += input[at + 1]!;
      at += 2;
      continue;
    }

    // Literal BBCode passthrough.
    if (ch === "[") {
      const token = readTagToken(input, at);
      if (token && !token.closing) {
        const bodyStart = at + token.length;
        const rawBody =
          (RAW_BODY_TAGS.has(token.tag) || token.tag === "url") &&
          token.param === undefined;
        if (rawBody) {
          const close = findClose(token.tag, bodyStart);
          if (close !== -1) {
            const end = close + `[/${token.tag}]`.length;
            out += input.slice(at, end); // verbatim, contents untouched
            if (token.tag === "eicon") {
              mark(at, end, "eicon");
            }
            at = end;
            continue;
          }
          report?.("unterminated-bbcode", base + at, token.raw);
        }
        const nestable =
          (WRAPPER_TAGS.has(token.tag) && token.param === undefined) ||
          (token.tag === "color" &&
            token.param !== undefined &&
            (BB_COLORS as readonly string[]).includes(
              token.param.trim().toLowerCase(),
            )) ||
          (token.tag === "url" &&
            token.param !== undefined &&
            validHref(token.param.trim()));
        if (nestable) {
          const close = findClose(token.tag, bodyStart);
          if (close !== -1) {
            const end = close + `[/${token.tag}]`.length;
            out +=
              input.slice(at, bodyStart) +
              translate(
                input.slice(bodyStart, close),
                report,
                base + bodyStart,
                spans,
              ) +
              input.slice(close, end);
            at = end;
            continue;
          }
          report?.("unterminated-bbcode", base + at, token.raw);
        } else if (!rawBody) {
          // A subset tag that literalized over its parameter: [b=x],
          // [user=x], [color]/[color=notacolor], [url=badhref]. Foreign
          // tags ([center], [img]…) are the pre-pass's business.
          const paramProblem =
            ((WRAPPER_TAGS.has(token.tag) || RAW_BODY_TAGS.has(token.tag)) &&
              token.param !== undefined) ||
            token.tag === "color" ||
            token.tag === "url";
          if (paramProblem) {
            report?.("invalid-bbcode-param", base + at, token.raw);
          }
        }
      }
      // Markdown link: [text](http://…)
      const link = /^\[([^\]\n]*)\]\((https?:\/\/[^\s)]+)\)/.exec(
        input.slice(at),
      );
      if (link && validHref(link[2]!)) {
        out += `[url=${link[2]!}]${translate(link[1]!, undefined, base + at + 1, spans)}[/url]`;
        at += link[0].length;
        continue;
      }
      out += ch;
      at += 1;
      continue;
    }

    // Code span: raw until the matching backtick.
    if (ch === "`") {
      const close = input.indexOf("`", at + 1);
      if (close !== -1 && close > at + 1) {
        out += `[noparse]${input.slice(at + 1, close)}[/noparse]`;
        mark(at, at + 1, "delim");
        mark(at + 1, close, "code");
        mark(close, close + 1, "delim");
        at = close + 1;
        continue;
      }
      out += ch;
      at += 1;
      continue;
    }

    if (input.startsWith("**", at)) {
      const close = findDelimiter(masked, at + 2, "**");
      if (close !== undefined) {
        out += `[b]${translate(input.slice(at + 2, close), report, base + at + 2, spans)}[/b]`;
        mark(at, at + 2, "delim");
        mark(at + 2, close, "bold");
        mark(close, close + 2, "delim");
        at = close + 2;
        continue;
      }
      if (masked[at + 2] !== undefined && masked[at + 2] !== " ") {
        report?.("unterminated-emphasis", base + at, "**");
      }
      out += "**";
      at += 2;
      continue;
    }

    if (ch === "*") {
      const close = findDelimiter(masked, at + 1, "*");
      if (close !== undefined && masked[close + 1] !== "*") {
        out += `[i]${translate(input.slice(at + 1, close), report, base + at + 1, spans)}[/i]`;
        mark(at, at + 1, "delim");
        mark(at + 1, close, "italic");
        mark(close, close + 1, "delim");
        at = close + 1;
        continue;
      }
      // A lone `*` only warns at a word start ("see *this") — mid-word
      // asterisks ("5*3") are far more often arithmetic than intent.
      if (
        close === undefined &&
        masked[at + 1] !== undefined &&
        masked[at + 1] !== " " &&
        (at === 0 || masked[at - 1] === " ")
      ) {
        report?.("unterminated-emphasis", base + at, "*");
      }
      out += ch;
      at += 1;
      continue;
    }

    // Spoiler: `||…||` is the supported spelling (Discord-style). The
    // contents translate like any run; the pipes themselves pass through —
    // on the wire they are plain text, so non-parsing clients degrade to
    // literal ||text|| instead of a foreign tag.
    if (input.startsWith("||", at)) {
      const close = findDelimiter(masked, at + 2, "||");
      if (close !== undefined) {
        out += `||${translate(input.slice(at + 2, close), report, base + at + 2, spans)}||`;
        mark(at, at + 2, "delim");
        mark(at + 2, close, "spoiler");
        mark(close, close + 2, "delim");
        at = close + 2;
        continue;
      }
      out += "||";
      at += 2;
      continue;
    }

    if (input.startsWith("~~", at)) {
      const close = findDelimiter(masked, at + 2, "~~");
      if (close !== undefined) {
        out += `[s]${translate(input.slice(at + 2, close), report, base + at + 2, spans)}[/s]`;
        mark(at, at + 2, "delim");
        mark(at + 2, close, "strike");
        mark(close, close + 2, "delim");
        at = close + 2;
        continue;
      }
      if (masked[at + 2] !== undefined && masked[at + 2] !== " ") {
        report?.("unterminated-emphasis", base + at, "~~");
      }
      out += "~~";
      at += 2;
      continue;
    }

    out += ch;
    at += 1;
  }
  return out;
}
