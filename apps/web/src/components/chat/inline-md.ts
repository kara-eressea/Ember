// SPIKE (#226): inline-rendering span tokenizer for the composer's Markdown
// dialect. Produces styled ranges over the *plain markdown string* — the
// document model stays a string, mdToBBCode stays the only wire translator,
// and this file only decides what to visually decorate. Rules mirror
// packages/markdown-bbcode/src/markdown.ts (escapes, code-span masking,
// CommonMark-ish flanking); a production version should share one scanner
// with the translator (export span events from translate()) so the two can
// never drift.

export type SpanType =
  "bold" | "italic" | "strike" | "spoiler" | "code" | "eicon" | "delim";

export interface MdSpan {
  from: number;
  to: number;
  type: SpanType;
}

/** Same masking rule as markdown.ts: complete backtick spans become NULs so
 * lookaheads never match inside code. */
function maskCode(input: string): string {
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
      out += input.slice(at, open + 1);
      at = open + 1;
      continue;
    }
    out += input.slice(at, open) + "\0".repeat(close - open + 1);
    at = close + 1;
  }
  return out;
}

/** CommonMark-ish closer search (mirrors markdown.ts findDelimiter). */
function findCloser(
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

const EICON = /\[eicon]([^[\]]{1,100})\[\/eicon]/giy;

const DELIMS: readonly { marker: string; type: SpanType }[] = [
  { marker: "**", type: "bold" },
  { marker: "~~", type: "strike" },
  { marker: "||", type: "spoiler" },
  { marker: "*", type: "italic" },
];

/**
 * All styled spans in `text`, base-offset `base`. Nested emphasis recurses,
 * so `**a *b* c**` yields overlapping bold + italic marks (CodeMirror mark
 * decorations combine). Spans are emitted in scan order; callers sort.
 */
function scan(text: string, base: number, out: MdSpan[]): void {
  const masked = maskCode(text);
  let at = 0;
  while (at < text.length) {
    const ch = text[at];
    if (ch === "\\") {
      at += 2;
      continue;
    }
    if (ch === "`") {
      const close = text.indexOf("`", at + 1);
      if (close !== -1 && close > at + 1) {
        out.push({ from: base + at, to: base + at + 1, type: "delim" });
        out.push({ from: base + at + 1, to: base + close, type: "code" });
        out.push({ from: base + close, to: base + close + 1, type: "delim" });
        at = close + 1;
        continue;
      }
      at += 1;
      continue;
    }
    if (ch === "[") {
      EICON.lastIndex = at;
      const m = EICON.exec(text);
      if (m && m.index === at) {
        out.push({
          from: base + at,
          to: base + at + m[0].length,
          type: "eicon",
        });
        at += m[0].length;
        continue;
      }
    }
    const hit = DELIMS.find(
      (d) => text.startsWith(d.marker, at) && masked[at] === d.marker[0],
    );
    if (hit) {
      const open = at + hit.marker.length;
      const close = findCloser(masked, open, hit.marker);
      if (close !== undefined) {
        out.push({ from: base + at, to: base + open, type: "delim" });
        out.push({ from: base + open, to: base + close, type: hit.type });
        out.push({
          from: base + close,
          to: base + close + hit.marker.length,
          type: "delim",
        });
        // Recurse into the content for nesting (bold containing italic…).
        scan(text.slice(open, close), base + open, out);
        at = close + hit.marker.length;
        continue;
      }
    }
    at += 1;
  }
}

/** Styled spans for a full composer value, sorted by position. */
export function inlineSpans(text: string): MdSpan[] {
  const out: MdSpan[] = [];
  // Per-line: emphasis never crosses a newline in the dialect.
  let offset = 0;
  for (const line of text.split("\n")) {
    scan(line, offset, out);
    offset += line.length + 1;
  }
  return out.sort((a, b) => a.from - b.from || a.to - b.to);
}
