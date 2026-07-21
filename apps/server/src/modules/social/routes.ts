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
import type { SessionRegistry } from "../session-engine/registry.js";

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
  sessions: SessionRegistry;
  tickets: TicketManagerRegistry;
  flistApi: FlistApiClient;
}

interface IdentityRow {
  id: string;
  character: string;
  accountId: string;
  accountName: string;
}

// eslint-disable-next-line @typescript-eslint/require-await -- fastify async plugin signature
export async function socialRoutes(
  instance: FastifyInstance,
  options: SocialRoutesOptions,
): Promise<void> {
  const app = instance.withTypeProvider<ZodTypeProvider>();
  const { db, sessions, tickets, flistApi } = options;

  app.addHook("preHandler", app.authenticate);

  async function ownedIdentity(
    identityId: string,
    userId: string,
  ): Promise<IdentityRow | undefined> {
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
    identity: IdentityRow,
    call: (auth: SocialAuth) => Promise<T>,
  ): Promise<T> {
    return withTicketFor(tickets, identity, call);
  }

  app.get(
    "/:identityId/social",
    {
      schema: {
        params: z.object({ identityId: z.uuid() }),
        response: {
          200: socialResponse,
          404: errorResponse,
          409: errorResponse,
          502: errorResponse,
          503: errorResponse,
        },
      },
      // Each hit is four upstream calls on the shared 1 req/s budget. The
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
      let bookmarks, friends, incoming, outgoing;
      try {
        [bookmarks, friends, incoming, outgoing] = await Promise.all([
          withTicket(identity, (auth) => flistApi.bookmarkList(auth)),
          withTicket(identity, (auth) => flistApi.friendList(auth)),
          withTicket(identity, (auth) => flistApi.requestList(auth)),
          withTicket(identity, (auth) => flistApi.requestPending(auth)),
        ]);
      } catch (error) {
        const mapped = upstreamStatus(error);
        return reply.code(mapped.code).send({ error: mapped.error });
      }
      const failed = [bookmarks, friends, incoming, outgoing].find(
        (result) => result.error !== "",
      );
      if (failed) {
        return reply.code(502).send({ error: failed.error });
      }
      // Presence enrichment from the live roster (empty when detached —
      // the names still render, just without status).
      const roster = sessions.get(identity.id)?.state.characters;
      const enrich = (name: string) => {
        const presence = roster?.get(name);
        return {
          name,
          online: presence !== undefined,
          status: presence?.status ?? "offline",
          statusmsg: presence?.statusmsg ?? "",
        };
      };
      return {
        bookmarks: (bookmarks.characters ?? []).map(enrich),
        // Account-wide pairs scoped to this identity: source is our
        // character, dest the friend (same orientation as friend-remove).
        friends: (friends.friends ?? [])
          .filter((pair) => pair.source === identity.character)
          .map((pair) => enrich(pair.dest)),
        incoming: (incoming.requests ?? [])
          .filter((entry) => entry.dest === identity.character)
          .map((entry) => ({ id: entry.id, name: entry.source })),
        outgoing: (outgoing.requests ?? [])
          .filter((entry) => entry.source === identity.character)
          .map((entry) => ({ id: entry.id, name: entry.dest })),
      };
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
      return { ok: true as const };
    },
  );
}
