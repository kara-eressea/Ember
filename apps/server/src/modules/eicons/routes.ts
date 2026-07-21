// Eicon search REST (M8 step 12): greps the server-local xariah index.
// The eiconSearchEnabled pref is enforced HERE, not just hidden in the UI
// — 403 when off, so the "server contacts xariah.net" gate is real. The
// index only ever downloads after a user with the pref enabled searches.

import { eq } from "drizzle-orm";
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { resolvePrefs } from "@emberchat/protocol";
import type { Db } from "../../db/index.js";
import { userPreferences } from "../../db/schema.js";
import type { EiconIndexService } from "./index-service.js";

const errorResponse = z.object({ error: z.string() });

export interface EiconsRoutesOptions {
  db: Db;
  eicons: EiconIndexService;
}

// eslint-disable-next-line @typescript-eslint/require-await -- fastify async plugin signature
export async function eiconsRoutes(
  instance: FastifyInstance,
  options: EiconsRoutesOptions,
): Promise<void> {
  const app = instance.withTypeProvider<ZodTypeProvider>();
  const { db, eicons } = options;

  app.addHook("preHandler", app.authenticate);

  /** The index only ever downloads from xariah.net after a user with the
   * pref enabled hits it — so both search and browse enforce the same gate. */
  async function eiconSearchEnabled(userId: string): Promise<boolean> {
    const [row] = await db
      .select({ prefs: userPreferences.prefs })
      .from(userPreferences)
      .where(eq(userPreferences.userId, userId))
      .limit(1);
    return resolvePrefs(row?.prefs ?? undefined).eiconSearchEnabled;
  }

  app.get(
    "/search",
    {
      schema: {
        querystring: z.object({ q: z.string().min(1).max(100) }),
        response: {
          200: z.object({ results: z.array(z.string()) }),
          403: errorResponse,
          502: errorResponse,
        },
      },
      config: { rateLimit: { max: 120, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      if (!(await eiconSearchEnabled(request.user.sub))) {
        return reply
          .code(403)
          .send({ error: "Eicon search is disabled in your preferences" });
      }
      try {
        return { results: await eicons.search(request.query.q) };
      } catch (error) {
        request.log.warn({ err: error }, "eicon search failed");
        return reply
          .code(502)
          .send({ error: "The eicon index is unavailable right now" });
      }
    },
  );

  app.get(
    "/browse",
    {
      schema: {
        querystring: z.object({
          offset: z.coerce.number().int().min(0).default(0),
          limit: z.coerce.number().int().min(1).max(120).default(60),
        }),
        response: {
          200: z.object({
            names: z.array(z.string()),
            total: z.number(),
          }),
          403: errorResponse,
          502: errorResponse,
        },
      },
      config: { rateLimit: { max: 120, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      if (!(await eiconSearchEnabled(request.user.sub))) {
        return reply
          .code(403)
          .send({ error: "Eicon browsing is disabled in your preferences" });
      }
      try {
        const { offset, limit } = request.query;
        return await eicons.browse(offset, limit);
      } catch (error) {
        request.log.warn({ err: error }, "eicon browse failed");
        return reply
          .code(502)
          .send({ error: "The eicon index is unavailable right now" });
      }
    },
  );
}
