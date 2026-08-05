// Channel directory REST (M6): GET serves the shared listing cache,
// refreshing it over the identity's live session when the cache is past the
// cooldown. The response always carries refreshedAt so the client can show
// how stale the point-in-time counts are.

import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import type { Db } from "../../db/index.js";
import { flistAccounts, identities } from "../../db/schema.js";
import type { SessionRegistry } from "@emberchat/session-engine";
import type { ChannelDirectory } from "./directory.js";

const directoryResponse = z.object({
  channels: z.array(
    z.object({
      key: z.string(),
      kind: z.enum(["official", "open"]),
      title: z.string(),
      characters: z.number(),
    }),
  ),
  refreshedAt: z.date().nullable(),
});

const errorResponse = z.object({ error: z.string() });

/** Production per-IP cap on directory reads (the cooldown already bounds
 * wire traffic; this bounds the DB reads a scripted client could force). */
export const DIRECTORY_RATE_LIMIT_MAX = 30;

export interface DirectoryRoutesOptions {
  db: Db;
  sessions: SessionRegistry;
  directory: ChannelDirectory;
  /** Per-IP cap; defaults to DIRECTORY_RATE_LIMIT_MAX. Derived from the
   * instance's global backstop so an operator who deliberately raises that
   * (many clients behind one address — the E2E suite is the extreme case,
   * one loopback IP for every worker) doesn't leave this route silently
   * 429ing the channel browser (E2E hang diagnosis, 2026-08-02). */
  rateLimitMax?: number;
}

// eslint-disable-next-line @typescript-eslint/require-await -- fastify async plugin signature
export async function directoryRoutes(
  instance: FastifyInstance,
  options: DirectoryRoutesOptions,
): Promise<void> {
  const app = instance.withTypeProvider<ZodTypeProvider>();
  const { db, sessions, directory } = options;
  const rateLimitMax = options.rateLimitMax ?? DIRECTORY_RATE_LIMIT_MAX;

  app.addHook("preHandler", app.authenticate);

  app.get(
    "/:identityId/directory",
    {
      schema: {
        params: z.object({ identityId: z.uuid() }),
        response: { 200: directoryResponse, 404: errorResponse },
      },
      config: { rateLimit: { max: rateLimitMax, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const [identity] = await db
        .select({ id: identities.id })
        .from(identities)
        .innerJoin(
          flistAccounts,
          eq(identities.flistAccountId, flistAccounts.id),
        )
        .where(
          and(
            eq(identities.id, request.params.identityId),
            eq(flistAccounts.userId, request.user.sub),
          ),
        )
        .limit(1);
      if (!identity) {
        return reply.code(404).send({ error: "Identity not found" });
      }
      const session = sessions.get(identity.id);
      return directory.get(session);
    },
  );
}
