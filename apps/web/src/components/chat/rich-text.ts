// The pure half of the render pipeline (COMPONENTS.md §7). BBCode structure
// comes from the shared AST (@emberchat/markdown-bbcode); this module handles
// the last-mile inline tokens inside plain text runs — links, @name mentions,
// #channel refs — and the /me emote shape. Kept free of React so it unit-tests
// without a DOM.

/**
 * Decode the HTML entities the F-Chat *server* injects into inbound text
 * (#335 follow-up). The reference client never escapes on send — the server
 * entity-escapes incoming text and re-broadcasts (and echoes) the escaped
 * form, so every wire text field arrives with `&` → `&amp;`, `<` → `&lt;`,
 * `>` → `&gt;`. Left undecoded, a signed CDN URL like
 * `…?ex=…&amp;is=…&amp;hm=…` reaches the DOM with literal `&amp;`, the CDN
 * sees a param named `amp;is`, and every Discord/twimg preview *and* direct
 * click 404s. F-List's own static URLs carry no query string, so they were
 * unaffected — matching the live report.
 *
 * We mirror the reference client's `decodeHTML` exactly (f-list/exported
 * `fchat/common.ts`): only these three entities, `&amp;` decoded LAST so a
 * user-typed `&amp;amp;` (server-escaped from a literal `&amp;`) collapses to
 * `&amp;` and never cascades to `&`. Deliberately NOT decoded: `&quot;`,
 * `&#39;`/`&apos;`, and numeric refs — the server never emits them and the
 * reference client renders them literally, so decoding them would diverge
 * from the ecosystem. React renders the result as text/attributes (never
 * innerHTML), so this stays injection-safe.
 *
 * Applies to inbound wire text only (messages, statuses, ads, channel
 * descriptions). Locally composed text in the composer/ad previews is
 * pre-wire — never server-escaped — so it must NOT be decoded.
 */
export function decodeWireEntities(text: string): string {
  return text
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&");
}

export type TextToken =
  | { kind: "plain"; text: string }
  | { kind: "link"; href: string }
  | { kind: "mention"; name: string }
  | { kind: "channel"; name: string };

// Longest/most-specific first (§7): URLs, then @name, then #channel.
// Mentions/channel refs must start a word (start-of-text or whitespace).
// @name is a single word: F-List names may contain spaces, but a plain-text
// token can't know where such a name ends — real name matching is the M5
// highlight rules' job; this is visual decoration only.
const TOKEN_RE =
  /(https?:\/\/[^\s<>"']+)|(?<=^|\s)@([A-Za-z0-9][A-Za-z0-9_-]{0,63})|(?<=^|\s)#([A-Za-z0-9][A-Za-z0-9_-]{0,63})/g;

/** One run of a plain-text slice: covered (`||…||` spoiler) or not. */
export interface SpoilerSegment {
  spoiler: boolean;
  text: string;
}

// `||…||` — the client-side spoiler spelling (#205). The pipes are plain
// characters on the wire, so this last-mile pass over text runs is the only
// place they gain meaning: a non-empty span between two `||` pairs becomes
// a covered segment. Anything unpaired stays literal.
const SPOILER_RE = /\|\|(?!\|)([\s\S]+?)\|\|/g;

export function spoilerSegments(text: string): SpoilerSegment[] {
  const segments: SpoilerSegment[] = [];
  let at = 0;
  for (const match of text.matchAll(SPOILER_RE)) {
    if (match.index > at) {
      segments.push({ spoiler: false, text: text.slice(at, match.index) });
    }
    segments.push({ spoiler: true, text: match[1]! });
    at = match.index + match[0].length;
  }
  if (at < text.length || segments.length === 0) {
    segments.push({ spoiler: false, text: text.slice(at) });
  }
  return segments;
}

export function textTokens(text: string): TextToken[] {
  const tokens: TextToken[] = [];
  let at = 0;
  for (const match of text.matchAll(TOKEN_RE)) {
    if (match.index > at) {
      tokens.push({ kind: "plain", text: text.slice(at, match.index) });
    }
    if (match[1] !== undefined) {
      tokens.push({ kind: "link", href: match[1] });
    } else if (match[2] !== undefined) {
      tokens.push({ kind: "mention", name: match[2] });
    } else {
      tokens.push({ kind: "channel", name: match[3]! });
    }
    at = match.index + match[0].length;
  }
  if (at < text.length) {
    tokens.push({ kind: "plain", text: text.slice(at) });
  }
  return tokens;
}

/**
 * The /me emote shape (official-client behavior: italic line, the name runs
 * into the action, no nick separator). `/me 's tail` keeps possessives tight
 * against the name.
 */
export function parseEmote(
  bbcode: string,
): { action: string; possessive: boolean } | undefined {
  if (bbcode.startsWith("/me ")) {
    const action = bbcode.slice(4);
    return { action, possessive: action.startsWith("'") };
  }
  if (bbcode.startsWith("/me'")) {
    // Possessive without the space: "/me's teacup…" — keep everything after
    // the /me prefix, tight against the name.
    return { action: bbcode.slice(3), possessive: true };
  }
  if (bbcode === "/me") {
    return { action: "", possessive: false };
  }
  return undefined;
}
