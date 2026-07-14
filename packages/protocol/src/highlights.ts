// Highlight rules (M5). Rules belong to the app account and apply across
// every identity's log. Matching is server-side at persist time — the sink
// stamps `messages.mention` under the rules active at that moment, and the
// flag is immutable: rule changes affect new messages only (decisions.md
// §10). Managed over REST (`GET/PUT /api/highlight-rules`), full-list
// replacement like the identity reorder.
//
// The schemas here validate shape; the server additionally compiles regex
// patterns in RE2 (linear-time, so a pattern that compiles cannot be a
// catastrophic-backtracking DoS) and rejects ones that don't compile.

import { z } from "zod";

export const HIGHLIGHT_RULE_KINDS = ["word", "nick", "regex"] as const;
export type HighlightRuleKind = (typeof HIGHLIGHT_RULE_KINDS)[number];

export const MAX_HIGHLIGHT_RULES = 100;
export const MAX_HIGHLIGHT_PATTERN_LENGTH = 200;

/** Matches the F-List character-name charset (see chat3client avatarURL). */
export const FLIST_NAME_RE = /^[a-zA-Z0-9_\-\s]+$/;

export const highlightRuleInputSchema = z
  .object({
    kind: z.enum(HIGHLIGHT_RULE_KINDS),
    // `word` and `nick` are literal terms matched at word boundaries,
    // case-insensitively; `regex` is an RE2 pattern applied as written.
    pattern: z.string().trim().min(1).max(MAX_HIGHLIGHT_PATTERN_LENGTH),
  })
  .refine((rule) => rule.kind !== "nick" || FLIST_NAME_RE.test(rule.pattern), {
    message: "nick rules must be a valid character name",
  });

export type HighlightRuleInput = z.infer<typeof highlightRuleInputSchema>;

/** PUT /api/highlight-rules body — an idempotent full-list replacement. */
export const putHighlightRulesSchema = z.object({
  rules: z.array(highlightRuleInputSchema).max(MAX_HIGHLIGHT_RULES),
});

export interface HighlightRuleDto {
  id: string;
  kind: HighlightRuleKind;
  pattern: string;
}
