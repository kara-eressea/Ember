// Client-side mention detection for live messages — mirrors the server's
// snapshot-time matcher (word-boundary, case-insensitive character-name
// match; M5 highlight rules will extend both sides together).

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** True when `bbcode` names `character` as a whole word. */
export function mentionsCharacter(bbcode: string, character: string): boolean {
  if (!character) {
    return false;
  }
  const pattern = new RegExp(
    `(^|[^\\w])${escapeRegex(character)}([^\\w]|$)`,
    "i",
  );
  return pattern.test(bbcode);
}
