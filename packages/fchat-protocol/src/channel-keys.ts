// Channel-key canonicalization.
//
// Official/public channels are addressed by name; private rooms by an
// "ADH-<hex>" id. F-Chat is inconsistent about the prefix case: the JCH echo
// uses "ADH-", but some responses (notably the RST make-open SYS) echo the id
// with a lowercased "adh-" prefix. Treated verbatim, the two forms key two
// distinct entries for one room (issue #311). Canonicalizing the prefix — and
// only the prefix, leaving the hex body untouched so the id still round-trips
// to the server — collapses them onto one key.

/** Uppercase an `adh-` prefix so private-room ids compare consistently. */
export function canonicalChannelKey(key: string): string {
  return /^adh-/i.test(key) ? `ADH-${key.slice(4)}` : key;
}
