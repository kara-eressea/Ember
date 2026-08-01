// Social actions (M6 step 7): bookmarks and friend requests through the
// F-List JSON API. Every upstream call rides the client's global 1 req/s
// throttle and authenticates with the account's current ticket via the
// per-account TicketManager (each new ticket invalidates all previous ones
// — no ad-hoc ticket fetches). Friend data is account-wide upstream; the
// GET scopes it to the identity's character and enriches names with live
// presence from the session roster.

import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import type { Db } from "../../db/index.js";
import { flistAccounts, identities } from "../../db/schema.js";
import type { FlistApiClient, SocialAuth } from "../flist-api/api-client.js";
import type { TicketManagerRegistry } from "../flist-api/ticket-manager.js";
import {
  upstreamStatus,
  withTicket as withTicketFor,
} from "../flist-api/with-ticket.js";
import type { SocialCache } from "./cache.js";
import type { SocialIdentity, SocialService } from "./service.js";

const characterRow = z.object({
  name: z.string(),
  online: z.boolean(),
  status: z.string(),
  statusmsg: z.string(),
});

const socialResponse = z.object({
  bookmarks: z.array(characterRow),
  friends: z.array(characterRow),
  incoming: z.array(z.object({ id: z.number(), name: z.string() })),
  outgoing: z.array(z.object({ id: z.number(), name: z.string() })),
});

const errorResponse = z.object({ error: z.string() });
const okResponse = z.object({ ok: z.literal(true) });

export interface SocialRoutesOptions {
  db: Db;
  tickets: TicketManagerRegistry;
  flistApi: FlistApiClient;
  /** Per-identity in-memory cache (#194) — also read by the gateway
   * snapshot, so a second device attaches without new F-List calls. */
  cache: SocialCache;
  /** Owns the four-call fetch, the cache write and the social.updated
   * fan-out — shared with the RTB refresh path (#364). */
  service: SocialService;
}

// eslint-disable-next-line @typescript-eslint/require-await -- fastify async plugin signature
export async function socialRoutes(
  instance: FastifyInstance,
  options: SocialRoutesOptions,
): Promise<void> {
  const app = instance.withTypeProvider<ZodTypeProvider>();
  const { db, tickets, flistApi, cache, service } = options;

  app.addHook("preHandler", app.authenticate);

  async function ownedIdentity(
    identityId: string,
    userId: string,
  ): Promise<SocialIdentity | undefined> {
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

  // Ticket-retry + upstream-error mapping shared with the profiles module
  // (extracted M8) — see flist-api/with-ticket.ts.
  function withTicket<T extends { error: string }>(
    identity: SocialIdentity,
    call: (auth: SocialAuth) => Promise<T>,
  ): Promise<T> {
    return withTicketFor(tickets, identity, call);
  }

  app.get(
    "/:identityId/social",
    {
      schema: {
        params: z.object({ identityId: z.uuid() }),
        // refresh=1 (the manual ↻ button) bypasses the cache; a plain GET
        // is served from cache while fresh — attach is instant (#194).
        querystring: z.object({ refresh: z.literal("1").optional() }),
        response: {
          200: socialResponse,
          404: errorResponse,
          409: errorResponse,
          502: errorResponse,
          503: errorResponse,
        },
      },
      // A cache-missing hit is four upstream calls on the shared 1 req/s budget. The
      // limiter runs pre-auth, so the key MUST NOT come from the request
      // (a path-param key would mint fresh buckets per rotated UUID and
      // bypass every ceiling — M6 audit). Per-IP with a generous ceiling:
      // legitimate use is load-once + manual refresh, and the upstream
      // budget is separately guarded by the client's queue cap.
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const identity = await ownedIdentity(
        request.params.identityId,
        request.user.sub,
      );
      if (!identity) {
        return reply.code(404).send({ error: "Identity not found" });
      }
      if (request.query.refresh !== "1" && cache.fresh(identity.id)) {
        // Cache hit inside the TTL: no upstream calls, presence re-read
        // from the live roster at serve time.
        return service.enriched(identity.id, cache.get(identity.id)!);
      }
      let result;
      try {
        result = await service.fetch(identity);
      } catch (error) {
        const mapped = upstreamStatus(error);
        return reply.code(mapped.code).send({ error: mapped.error });
      }
      if (result.error !== undefined) {
        return reply.code(502).send({ error: result.error });
      }
      return service.enriched(identity.id, result.lists);
    },
  );

  app.post(
    "/:identityId/social/bookmark",
    {
      schema: {
        params: z.object({ identityId: z.uuid() }),
        body: z.object({
          action: z.enum(["add", "remove"]),
          name: z.string().min(1).max(64),
        }),
        response: {
          200: okResponse,
          404: errorResponse,
          409: errorResponse,
          502: errorResponse,
          503: errorResponse,
        },
      },
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const identity = await ownedIdentity(
        request.params.identityId,
        request.user.sub,
      );
      if (!identity) {
        return reply.code(404).send({ error: "Identity not found" });
      }
      const { action, name } = request.body;
      let result;
      try {
        result = await withTicket(identity, (auth) =>
          action === "add"
            ? flistApi.bookmarkAdd(auth, name)
            : flistApi.bookmarkRemove(auth, name),
        );
      } catch (error) {
        const mapped = upstreamStatus(error);
        return reply.code(mapped.code).send({ error: mapped.error });
      }
      if (result.error !== "") {
        return reply.code(502).send({ error: result.error });
      }
      // Fold the change into the cache and fan it out — every attached
      // device's bookmark rows update instantly (#199). A cache miss
      // means nothing was loaded yet; the first GET fetches the truth.
      const patched = cache.patchBookmark(identity.id, action, name);
      if (patched) {
        service.broadcast(identity.id, patched);
      }
      return { ok: true as const };
    },
  );

  app.post(
    "/:identityId/social/request",
    {
      schema: {
        params: z.object({ identityId: z.uuid() }),
        body: z.discriminatedUnion("action", [
          z.object({
            action: z.literal("send"),
            character: z.string().min(1).max(64),
          }),
          z.object({
            action: z.literal("remove-friend"),
            character: z.string().min(1).max(64),
          }),
          z.object({
            action: z.literal("accept"),
            requestId: z.number().int(),
          }),
          z.object({ action: z.literal("deny"), requestId: z.number().int() }),
          z.object({
            action: z.literal("cancel"),
            requestId: z.number().int(),
          }),
        ]),
        response: {
          200: okResponse,
          404: errorResponse,
          409: errorResponse,
          502: errorResponse,
          503: errorResponse,
        },
      },
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const identity = await ownedIdentity(
        request.params.identityId,
        request.user.sub,
      );
      if (!identity) {
        return reply.code(404).send({ error: "Identity not found" });
      }
      const body = request.body;
      let result;
      try {
        result = await withTicket(identity, (auth) => {
          switch (body.action) {
            case "send":
              return flistApi.requestSend(
                auth,
                identity.character,
                body.character,
              );
            case "remove-friend":
              return flistApi.friendRemove(
                auth,
                identity.character,
                body.character,
              );
            case "accept":
              return flistApi.requestAccept(auth, body.requestId);
            case "deny":
              return flistApi.requestDeny(auth, body.requestId);
            case "cancel":
              return flistApi.requestCancel(auth, body.requestId);
          }
        });
      } catch (error) {
        const mapped = upstreamStatus(error);
        return reply.code(mapped.code).send({ error: mapped.error });
      }
      if (result.error !== "") {
        return reply.code(502).send({ error: result.error });
      }
      // Friend/request effects (pair rows, request ids) cannot be patched
      // locally — drop the cache so the client's follow-up refresh (and
      // everyone else's next GET) refetches and fans out fresh lists.
      cache.invalidate(identity.id);
      return { ok: true as const };
    },
  );
}
