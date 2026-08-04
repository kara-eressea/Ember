// Member-row status rendering (#494): the restricted BBCode subset a status
// line in the member list renders, as a flat segment list.
//
// The row used to flatten the status to plain text (bbcodeToText), so a
// `[color=green]…[/color]` status showed uncoloured — the bug. It cannot
// simply switch to the full renderer the mini profile card uses (#210): a
// member row IS a <button>, and RichText renders its own buttons (link
// chips, [user], #channel, spoilers), which is invalid HTML, and its 60px
// inline eicon box would tear a 40-ish-pixel row apart.
//
// So this is the middle path — the same *content* the card shows, in the
// subset a dense row can carry: `[color]` keeps its colour, `[icon]`/
// `[eicon]` survive as images pinned to the line box, and every other tag
// degrades to exactly the visible text `bbcodeToText` would have produced.
// Nothing here is interactive, so nothing nests a control inside the row.

import {
  parseBBCode,
  type BBColor,
  type BBNode,
} from "@emberchat/markdown-bbcode";
import { decodeWireEntities } from "../../lib/wire-text.js";

export type StatusSegment =
  | { kind: "text"; text: string; color?: BBColor }
  | { kind: "image"; tag: "icon" | "eicon"; name: string };

/**
 * Wire status message → the segments a member row renders. Inbound wire text
 * is entity-decoded before parsing, exactly as RichText does for the same
 * strings (the decode-exactly-once contract in wire-text.ts): this is that
 * string's one decode on this path, and `wireToPlainText` is its own decode
 * for the tooltip.
 *
 * Whitespace collapses and the run is trimmed, like `bbcodeToText` — a
 * multi-line status must read as one clipped line, never as a tall row.
 */
export function statusSegments(wire: string): StatusSegment[] {
  const out: StatusSegment[] = [];
  walk(parseBBCode(decodeWireEntities(wire)), undefined, out);
  return tidy(out);
}

function walk(
  nodes: readonly BBNode[],
  color: BBColor | undefined,
  out: StatusSegment[],
): void {
  for (const node of nodes) {
    switch (node.type) {
      case "text":
      case "noparse":
        out.push({ kind: "text", text: node.text, color });
        break;
      case "name":
        // [user] keeps its name as plain text (a mention chip would be a
        // button); the two image tags become images.
        if (node.tag === "user") {
          out.push({ kind: "text", text: node.name, color });
        } else {
          out.push({ kind: "image", tag: node.tag, name: node.name });
        }
        break;
      case "channel":
        // An invite link degrades to its visible label, never to nothing.
        out.push({ kind: "text", text: node.label, color });
        break;
      case "color":
        // Innermost colour wins, the way nested spans paint.
        walk(node.children, node.color, out);
        break;
      case "url":
      case "wrapper":
      case "spoiler":
      case "block":
      case "collapse":
        // No emphasis, no link chip, no cover — just the text they wrap.
        // (A [spoiler] reveals here exactly as it already did in the plain
        // text this replaces, and still does in the row's tooltip.)
        walk(node.children, color, out);
        break;
      case "img":
        out.push({ kind: "text", text: node.alt, color });
        break;
      case "hr":
        out.push({ kind: "text", text: " ", color });
        break;
    }
  }
}

/** Collapse whitespace, merge neighbours that would render identically, and
 * trim the ends — so the segment list is the shortest one that renders the
 * same line. */
function tidy(segments: StatusSegment[]): StatusSegment[] {
  const merged: StatusSegment[] = [];
  for (const segment of segments) {
    if (segment.kind === "image") {
      merged.push(segment);
      continue;
    }
    const text = segment.text.replace(/\s+/g, " ");
    if (text === "") {
      continue;
    }
    const previous = merged.at(-1);
    if (
      previous?.kind === "text" &&
      previous.color === segment.color &&
      // " " + " " must not become "  ".
      !(previous.text.endsWith(" ") && text === " ")
    ) {
      merged[merged.length - 1] = { ...previous, text: previous.text + text };
    } else {
      merged.push({ ...segment, text });
    }
  }
  trimEnd(merged, 0, (text) => text.trimStart());
  trimEnd(merged, merged.length - 1, (text) => text.trimEnd());
  return merged.filter(
    (segment) => segment.kind === "image" || segment.text !== "",
  );
}

function trimEnd(
  segments: StatusSegment[],
  index: number,
  trim: (text: string) => string,
): void {
  const segment = segments[index];
  if (segment?.kind === "text") {
    segments[index] = { ...segment, text: trim(segment.text) };
  }
}
