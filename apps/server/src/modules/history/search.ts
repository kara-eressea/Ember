// In-log search (M9 step 2): the Discord-style query mini-language, parsed
// server-side so every client speaks the same dialect. Filters:
//   from:Name        sender (one word)
//   from:"Full Name" sender with spaces
//   before:YYYY-MM-DD / after:YYYY-MM-DD
// Anything else is free text, matched case-insensitively as a substring
// (ILIKE — personal-instance scale; the shape leaves room for FTS later).
// A token that looks like a filter but doesn't parse (bad date) is kept as
// plain text rather than silently dropped.

export interface ParsedSearch {
  /** Free text after filter extraction, whitespace-normalized. */
  text: string;
  /** Sender filter, matched case-insensitively against the exact name. */
  from?: string;
  /** Exclusive upper bound (start of the named day), epoch ms. */
  beforeMs?: number;
  /** Inclusive lower bound (start of the named day), epoch ms. */
  afterMs?: number;
}

const TOKEN = /(\w+):(?:"([^"]*)"|(\S+))|\S+/g;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function parseSearchQuery(query: string): ParsedSearch {
  const parsed: ParsedSearch = { text: "" };
  const text: string[] = [];
  for (const match of query.matchAll(TOKEN)) {
    const key = match[1]?.toLowerCase();
    const value = match[2] ?? match[3];
    if (key === "from" && value) {
      parsed.from = value;
      continue;
    }
    if ((key === "before" || key === "after") && value && DATE.test(value)) {
      const ms = Date.parse(`${value}T00:00:00Z`);
      if (!Number.isNaN(ms)) {
        parsed[key === "before" ? "beforeMs" : "afterMs"] = ms;
        continue;
      }
    }
    text.push(match[0]);
  }
  parsed.text = text.join(" ").trim();
  return parsed;
}

/** Escape ILIKE wildcards so user text matches literally. */
export function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (char) => `\\${char}`);
}
