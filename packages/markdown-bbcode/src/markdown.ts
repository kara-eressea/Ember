// Markdown → F-Chat BBCode. The compose-side half of the M4 Markdown layer:
// the composer accepts the inline Markdown from ui/COMPONENTS.md §7 and the
// wire gets well-structured subset BBCode (developer policy — never emit a
// tag outside `b i u s sup sub color url user icon eicon noparse`).
//
// Mapping:
//   **bold**        → [b]bold[/b]
//   *italic*        → [i]italic[/i]
//   ~~strike~~      → [s]strike[/s]
//   `code`          → [noparse]code[/noparse]   (F-Chat has no code tag;
//                     noparse keeps the span literal, the client renders it
//                     as code — official clients just show the text)
//   [text](http://…)→ [url=http://…]text[/url]
//   \* \` \~ \[ \\  → the literal character
//
// BBCode typed literally passes through untouched (milestone-4.md):
// complete subset elements are copied verbatim — raw-body tags wholesale,
// wrapper/color/url tags with their contents still Markdown-processed.
// Anything ambiguous or unterminated stays literal text; this function
// never throws.

import { BB_COLORS, BB_NAME_TAGS, BB_WRAPPER_TAGS } from "./bbcode.js";

const ESCAPABLE = new Set(["*", "`", "~", "[", "]", "\\", "("]);

function isWrapperTag(tag: string): boolean {
  return (BB_WRAPPER_TAGS as readonly string[]).includes(tag);
}

function isRawBodyTag(tag: string): boolean {
  return tag === "noparse" || (BB_NAME_TAGS as readonly string[]).includes(tag);
}

function validHref(href: string): boolean {
  return /^https?:\/\/\S+$/i.test(href);
}

/** `[tag]` / `[/tag]` / `[tag=param]` at `input[at]`, or nothing. */
function readBBToken(
  input: string,
  at: number,
):
  | { closing: boolean; tag: string; param?: string; length: number }
  | undefined {
  const match = /^\[(\/?)([a-zA-Z]+)(?:=([^\]\n]*))?\]/.exec(input.slice(at));
  if (!match) {
    return undefined;
  }
  return {
    closing: match[1] === "/",
    tag: match[2]!.toLowerCase(),
    ...(match[3] !== undefined ? { param: match[3] } : {}),
    length: match[0].length,
  };
}

/**
 * Is this opener the start of a passthrough-able subset element? Returns
 * the position just past its `[/tag]`, or undefined.
 */
function bbElementEnd(
  input: string,
  at: number,
  tag: string,
): number | undefined {
  const close = input.toLowerCase().indexOf(`[/${tag}]`, at);
  return close === -1 ? undefined : close + `[/${tag}]`.length;
}

/**
 * Finds the closing run of `delimiter` after `from` with CommonMark-ish
 * flanking: the opener must be followed by non-space, the closer preceded
 * by non-space. Returns the index of the closer, or undefined.
 */
function findDelimiter(
  input: string,
  from: number,
  delimiter: string,
): number | undefined {
  if (from >= input.length || input[from] === " ") {
    return undefined;
  }
  let at = from;
  while (at < input.length) {
    const index = input.indexOf(delimiter, at);
    if (index === -1) {
      return undefined;
    }
    if (index > from && input[index - 1] !== " " && input[index - 1] !== "\\") {
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

function translate(input: string): string {
  let out = "";
  let at = 0;

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
      const token = readBBToken(input, at);
      if (token && !token.closing) {
        const bodyStart = at + token.length;
        if (isRawBodyTag(token.tag) && token.param === undefined) {
          const end = bbElementEnd(input, bodyStart, token.tag);
          if (end !== undefined) {
            out += input.slice(at, end); // verbatim, contents untouched
            at = end;
            continue;
          }
        }
        const nestable =
          (isWrapperTag(token.tag) && token.param === undefined) ||
          (token.tag === "color" &&
            token.param !== undefined &&
            (BB_COLORS as readonly string[]).includes(
              token.param.trim().toLowerCase(),
            )) ||
          (token.tag === "url" &&
            token.param !== undefined &&
            validHref(token.param.trim()));
        if (nestable) {
          const end = bbElementEnd(input, bodyStart, token.tag);
          if (end !== undefined) {
            const closeLen = `[/${token.tag}]`.length;
            out +=
              input.slice(at, bodyStart) +
              translate(input.slice(bodyStart, end - closeLen)) +
              input.slice(end - closeLen, end);
            at = end;
            continue;
          }
        }
      }
      // Markdown link: [text](http://…)
      const link = /^\[([^\]\n]*)\]\((https?:\/\/[^\s)]+)\)/.exec(
        input.slice(at),
      );
      if (link && validHref(link[2]!)) {
        out += `[url=${link[2]!}]${translate(link[1]!)}[/url]`;
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
        at = close + 1;
        continue;
      }
      out += ch;
      at += 1;
      continue;
    }

    if (input.startsWith("**", at)) {
      const close = findDelimiter(input, at + 2, "**");
      if (close !== undefined) {
        out += `[b]${translate(input.slice(at + 2, close))}[/b]`;
        at = close + 2;
        continue;
      }
      out += "**";
      at += 2;
      continue;
    }

    if (ch === "*") {
      const close = findDelimiter(input, at + 1, "*");
      if (close !== undefined && input[close + 1] !== "*") {
        out += `[i]${translate(input.slice(at + 1, close))}[/i]`;
        at = close + 1;
        continue;
      }
      out += ch;
      at += 1;
      continue;
    }

    if (input.startsWith("~~", at)) {
      const close = findDelimiter(input, at + 2, "~~");
      if (close !== undefined) {
        out += `[s]${translate(input.slice(at + 2, close))}[/s]`;
        at = close + 2;
        continue;
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
