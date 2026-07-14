// Highlight-rules REST (M5): GET returns the user's rules, PUT replaces the
// full list (idempotent, like the identity reorder — a stale tab fails
// loudly instead of interleaving). Regex patterns must compile in RE2 at
// PUT time; a refused pattern is the client's 422, not a silently skipped
// row at match time.

import { asc, eq } from "drizzle-orm";
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import {
  HIGHLIGHT_RULE_KINDS,
  putHighlightRulesSchema,
  type HighlightRuleDto,
} from "@emberchat/protocol";
import type { Db } from "../../db/index.js";
import { highlightRules } from "../../db/schema.js";
import { compileRule, type HighlightMatcher } from "./matcher.js";

const ruleResponse = z.object({
  id: z.string(),
  kind: z.enum(HIGHLIGHT_RULE_KINDS),
  pattern: z.string(),
});

const errorResponse = z.object({ error: z.string() });

export interface HighlightsRoutesOptions {
  db: Db;
  highlights: HighlightMatcher;
}

// eslint-disable-next-line @typescript-eslint/require-await -- fastify async plugin signature
export async function highlightsRoutes(
  instance: FastifyInstance,
  options: HighlightsRoutesOptions,
): Promise<void> {
  const app = instance.withTypeProvider<ZodTypeProvider>();
  const { db, highlights } = options;

  app.addHook("preHandler", app.authenticate);

  async function listRules(userId: string): Promise<HighlightRuleDto[]> {
    const rows = await db
      .select({
        id: highlightRules.id,
        kind: highlightRules.kind,
        pattern: highlightRules.pattern,
      })
      .from(highlightRules)
      .where(eq(highlightRules.userId, userId))
      .orderBy(asc(highlightRules.createdAt), asc(highlightRules.id));
    return rows;
  }

  app.get(
    "/",
    {
      schema: {
        response: { 200: z.object({ rules: z.array(ruleResponse) }) },
      },
    },
    async (request) => ({ rules: await listRules(request.user.sub) }),
  );

  app.put(
    "/",
    {
      schema: {
        body: putHighlightRulesSchema,
        response: {
          200: z.object({ rules: z.array(ruleResponse) }),
          422: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const userId = request.user.sub;
      for (const rule of request.body.rules) {
        try {
          compileRule(rule.kind, rule.pattern);
        } catch {
          return reply
            .code(422)
            .send({ error: `pattern does not compile: ${rule.pattern}` });
        }
      }
      // Dedupe (kind, pattern) within the payload so a sloppy client can't
      // trip the unique index into a 500.
      const seen = new Set<string>();
      const rules = request.body.rules.filter((rule) => {
        const key = `${rule.kind}:${rule.pattern}`;
        if (seen.has(key)) {
          return false;
        }
        seen.add(key);
        return true;
      });
      await db.transaction(async (tx) => {
        await tx
          .delete(highlightRules)
          .where(eq(highlightRules.userId, userId));
        if (rules.length > 0) {
          await tx
            .insert(highlightRules)
            .values(rules.map((rule) => ({ userId, ...rule })));
        }
      });
      highlights.invalidate(userId);
      return { rules: await listRules(userId) };
    },
  );
}
