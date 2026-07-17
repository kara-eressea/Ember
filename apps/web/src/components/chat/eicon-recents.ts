// EiconPicker Recents plumbing (M8 step 11): which eicons a message used,
// and how they fold into the `eiconRecents` pref (most-recent-first,
// deduped, capped at the schema's 50). Recording happens on picker insert
// AND on send — typed `[eicon]` tags count too, which is also how the
// picker bootstraps before search exists: type one, star it from Recents.

import { EICON_NAME } from "@emberchat/protocol";

const EICON_TAG = /\[eicon]([^[\]]+)\[\/eicon]/gi;

/** Eicon names used in a wire-form BBCode body, order of appearance,
 * deduped, invalid charsets dropped (the pref schema would refuse them). */
export function eiconsIn(bbcode: string): string[] {
  const names: string[] = [];
  for (const match of bbcode.matchAll(EICON_TAG)) {
    const name = match[1]?.trim();
    if (
      name !== undefined &&
      name !== "" &&
      name.length <= 100 &&
      EICON_NAME.test(name) &&
      !names.some((seen) => seen.toLowerCase() === name.toLowerCase())
    ) {
      names.push(name);
    }
  }
  return names;
}

/** Fold newly used names into the recents list, newest first. */
export function mergeRecents(
  existing: readonly string[],
  used: readonly string[],
  max = 50,
): string[] {
  const lower = new Set(used.map((name) => name.toLowerCase()));
  return [
    ...used,
    ...existing.filter((name) => !lower.has(name.toLowerCase())),
  ].slice(0, max);
}
