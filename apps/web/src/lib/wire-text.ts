// Wire-text helpers (#335 follow-up, #350). Everything the F-Chat *server*
// re-broadcasts has been entity-escaped by the server — the reference client
// sends raw and only decodes on receive — so every inbound text field arrives
// with `&` → `&amp;`, `<` → `&lt;`, `>` → `&gt;`. These helpers are the single
// place the web client de-escapes that wire text, so the decode stays
// exactly-once and consistent across every surface.

import { bbcodeToText } from "@emberchat/markdown-bbcode";

/**
 * Decode the three HTML entities the F-Chat server injects into inbound text.
 * Mirrors the reference client's `decodeHTML` exactly (f-list/exported
 * `fchat/common.ts`): only these entities, `&amp;` decoded LAST so a
 * user-typed `&amp;amp;` (server-escaped from a literal `&amp;`) collapses to
 * `&amp;` and never cascades to `&`. Deliberately NOT decoded: `&quot;`,
 * `&#39;`/`&apos;`, and numeric refs — the server never emits them and the
 * reference client renders them literally, so decoding them would diverge from
 * the ecosystem. Callers render the result as React text/attributes (never
 * innerHTML), so this stays injection-safe.
 *
 * DECODE-EXACTLY-ONCE CONTRACT: apply this to inbound wire text on exactly one
 * path. `RichText` already decodes wire text it renders (its non-`local`
 * path), so surfaces that hand a string to `RichText` must NOT also decode it
 * here. Because `&amp;` is decoded last, a second pass is *corrupting* for
 * literal user text (`&amp;amp;` → `&amp;` → `&`), never idempotent — so the
 * split is deliberate: `RichText` owns its path, these helpers own the
 * plain-text/attribute surfaces that never reach `RichText`.
 */
export function decodeWireEntities(text: string): string {
  return text
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&");
}

/**
 * Flatten wire BBCode to its visible plain text AND decode the server's
 * entities — for one-line/dense surfaces that render wire text OUTSIDE
 * `RichText` (member-list status lines, status tooltips). Tags strip first,
 * then the surviving text content is de-escaped. These surfaces never also
 * pass through `RichText`, so this is the single decode of that string.
 */
export function wireToPlainText(bbcode: string): string {
  return decodeWireEntities(bbcodeToText(bbcode));
}
