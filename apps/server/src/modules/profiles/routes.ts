// Profile REST routes (M8) under /api/identities/:identityId — REST rather
// than gateway commands on purpose: large payloads, no fan-out, and HTTP
// error semantics (404 unknown character / 409 locked vault / 429 budget /
// 502 upstream) map cleanly.

import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import {
  guestbookPageSchema,
  profileHistoryEntrySchema,
  profileInsightsSchema,
  profileResponseSchema,
} from "@emberchat/protocol";
import type { Db } from "../../db/index.js";
import { flistAccounts, identities } from "../../db/schema.js";
import { upstreamStatus } from "../flist-api/with-ticket.js";
import type { ProfileIdentity, ProfileService } from "./service.js";

const errorResponse = z.object({ error: z.string() });
const budgetResponse = z.object({
  error: z.string(),
  retryAfterSeconds: z.number(),
});

const identityParams = z.object({ identityId: z.uuid() });
const characterParams = z.object({
  identityId: z.uuid(),
  name: z.string().min(1).max(64),
});

export interface ProfilesRoutesOptions {
  db: Db;
  profiles: ProfileService;
}

// eslint-disable-next-line @typescript-eslint/require-await -- fastify async plugin signature
export async function profilesRoutes(
  instance: FastifyInstance,
  options: ProfilesRoutesOptions,
): Promise<void> {
  const app = instance.withTypeProvider<ZodTypeProvider>();
  const { db, profiles } = options;

  app.addHook("preHandler", app.authenticate);

  async function ownedIdentity(
    identityId: string,
    userId: string,
  ): Promise<ProfileIdentity | undefined> {
    const [row] = await db
      .select({
        id: identities.id,
        character: identities.characterName,
        accountId: flistAccounts.id,
        accountName: flistAccounts.accountName,
      })
      .from(identities)
      .innerJoin(flistAccounts, eq(identities.flistAccountId, flistAccounts.id))
      .where(
        and(eq(identities.id, identityId), eq(flistAccounts.userId, userId)),
      )
      .limit(1);
    return row;
  }

  // Per-IP ceilings: generous for cache-served reads, tight for the routes
  // that can spend upstream budget. (Same pre-auth keying rule as social —
  // never key limits on request params.)
  const readLimit = { rateLimit: { max: 120, timeWindow: "1 minute" } };
  const fetchLimit = { rateLimit: { max: 60, timeWindow: "1 minute" } };

  app.get(
    "/:identityId/profile/:name",
    {
      schema: {
        params: characterParams,
        querystring: z.object({ refresh: z.stringbool().default(false) }),
        response: {
          200: profileResponseSchema,
          404: errorResponse,
          409: errorResponse,
          429: budgetResponse,
          502: errorResponse,
          503: errorResponse,
        },
      },
      config: fetchLimit,
    },
    async (request, reply) => {
      const identity = await ownedIdentity(
        request.params.identityId,
        request.user.sub,
      );
      if (!identity) {
        return reply.code(404).send({ error: "Identity not found" });
      }
      let result;
      try {
        result = await profiles.getProfile(
          identity,
          request.params.name,
          request.query.refresh,
        );
      } catch (error) {
        const mapped = upstreamStatus(error);
        return reply.code(mapped.code).send({ error: mapped.error });
      }
      if (result.status === "not-found") {
        return reply.code(404).send({ error: result.error });
      }
      if (result.status === "budget-exhausted") {
        return reply.code(429).send({
          error: "Hourly profile budget exhausted",
          retryAfterSeconds: result.retryAfterSeconds,
        });
      }
      return {
        profile: result.profile,
        fetchedAt: result.fetchedAt,
        stale: result.stale,
        budgetExhausted: result.budgetExhausted,
        note: result.note,
      };
    },
  );

  app.get(
    "/:identityId/profile-history",
    {
      schema: {
        params: identityParams,
        querystring: z.object({
          limit: z.coerce.number().int().min(1).max(100).default(50),
          before: z.coerce.number().int().optional(),
        }),
        response: {
          200: z.object({ history: z.array(profileHistoryEntrySchema) }),
          404: errorResponse,
        },
      },
      config: readLimit,
    },
    async (request, reply) => {
      const identity = await ownedIdentity(
        request.params.identityId,
        request.user.sub,
      );
      if (!identity) {
        return reply.code(404).send({ error: "Identity not found" });
      }
      return {
        history: await profiles.history(
          identity.id,
          request.query.limit,
          request.query.before,
        ),
      };
    },
  );

  app.delete(
    "/:identityId/profile-history/:name",
    {
      schema: {
        params: characterParams,
        response: {
          200: z.object({ ok: z.literal(true) }),
          404: errorResponse,
        },
      },
      config: readLimit,
    },
    async (request, reply) => {
      const identity = await ownedIdentity(
        request.params.identityId,
        request.user.sub,
      );
      if (!identity) {
        return reply.code(404).send({ error: "Identity not found" });
      }
      const deleted = await profiles.deleteHistory(
        identity.id,
        request.params.name,
      );
      if (!deleted) {
        return reply.code(404).send({ error: "No history entry" });
      }
      return { ok: true as const };
    },
  );

  app.get(
    "/:identityId/profile/:name/note",
    {
      schema: {
        params: characterParams,
        response: {
          200: z.object({ note: z.string().nullable() }),
          404: errorResponse,
        },
      },
      config: readLimit,
    },
    async (request, reply) => {
      const identity = await ownedIdentity(
        request.params.identityId,
        request.user.sub,
      );
      if (!identity) {
        return reply.code(404).send({ error: "Identity not found" });
      }
      return { note: await profiles.getNote(identity.id, request.params.name) };
    },
  );

  app.put(
    "/:identityId/profile/:name/note",
    {
      schema: {
        params: characterParams,
        body: z.object({ note: z.string().max(20_000) }),
        response: {
          200: z.object({ ok: z.literal(true) }),
          404: errorResponse,
        },
      },
      config: readLimit,
    },
    async (request, reply) => {
      const identity = await ownedIdentity(
        request.params.identityId,
        request.user.sub,
      );
      if (!identity) {
        return reply.code(404).send({ error: "Identity not found" });
      }
      await profiles.putNote(
        identity.id,
        request.params.name,
        request.body.note,
      );
      return { ok: true as const };
    },
  );

  app.get(
    "/:identityId/profile/:name/insights",
    {
      schema: {
        params: characterParams,
        response: {
          200: profileInsightsSchema,
          404: errorResponse,
        },
      },
      config: readLimit,
    },
    async (request, reply) => {
      const identity = await ownedIdentity(
        request.params.identityId,
        request.user.sub,
      );
      if (!identity) {
        return reply.code(404).send({ error: "Identity not found" });
      }
      return profiles.insights(identity.id, request.params.name);
    },
  );

  app.get(
    "/:identityId/profile/:name/guestbook",
    {
      schema: {
        params: characterParams,
        querystring: z.object({
          page: z.coerce.number().int().min(0).default(0),
        }),
        response: {
          200: guestbookPageSchema,
          404: errorResponse,
          409: errorResponse,
          429: budgetResponse,
          502: errorResponse,
          503: errorResponse,
        },
      },
      config: fetchLimit,
    },
    async (request, reply) => {
      const identity = await ownedIdentity(
        request.params.identityId,
        request.user.sub,
      );
      if (!identity) {
        return reply.code(404).send({ error: "Identity not found" });
      }
      let result;
      try {
        result = await profiles.guestbook(
          identity,
          request.params.name,
          request.query.page,
        );
      } catch (error) {
        const mapped = upstreamStatus(error);
        return reply.code(mapped.code).send({ error: mapped.error });
      }
      if (result.status === "no-guestbook") {
        return reply
          .code(404)
          .send({ error: "This character does not have a guestbook" });
      }
      if (result.status === "budget-exhausted") {
        return reply.code(429).send({
          error: "Hourly profile budget exhausted",
          retryAfterSeconds: result.retryAfterSeconds,
        });
      }
      if (result.status === "upstream-error") {
        return reply.code(502).send({ error: result.error });
      }
      return result.page;
    },
  );

  // The F-List memo, for the one-way note-import affordance. Budget-free.
  app.get(
    "/:identityId/profile/:name/memo",
    {
      schema: {
        params: characterParams,
        response: {
          200: z.object({ note: z.string().nullable() }),
          404: errorResponse,
          409: errorResponse,
          502: errorResponse,
          503: errorResponse,
        },
      },
      config: fetchLimit,
    },
    async (request, reply) => {
      const identity = await ownedIdentity(
        request.params.identityId,
        request.user.sub,
      );
      if (!identity) {
        return reply.code(404).send({ error: "Identity not found" });
      }
      let result;
      try {
        result = await profiles.memo(identity, request.params.name);
      } catch (error) {
        const mapped = upstreamStatus(error);
        return reply.code(mapped.code).send({ error: mapped.error });
      }
      if ("status" in result) {
        return reply.code(502).send({ error: result.error });
      }
      return { note: result.note };
    },
  );
}
