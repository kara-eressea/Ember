// History REST: conversation list + cursor-paginated messages
// (architecture.md §REST). Cursor = messages.id (bigserial, arrival order):
// ?before=<msgId> walks toward older history, pages come back ascending so
// the client can prepend them directly.

import { and, desc, eq, lt } from "drizzle-orm";
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import type { Db } from "../../db/index.js";
import {
  conversations,
  flistAccounts,
  identities,
  messages,
} from "../../db/schema.js";

const conversationResponse = z.object({
  id: z.string(),
  kind: z.enum(["channel", "pm"]),
  channelKey: z.string().nullable(),
  partnerCharacter: z.string().nullable(),
  title: z.string(),
  pinned: z.boolean(),
  joined: z.boolean(),
  lastReadMessageId: z.number().nullable(),
});

const messageResponse = z.object({
  id: z.number(),
  senderCharacter: z.string(),
  kind: z.enum(["msg", "lrp", "rll", "sys", "pm"]),
  bbcode: z.string(),
  sentByUs: z.boolean(),
  createdAt: z.date(),
});

const errorResponse = z.object({ error: z.string() });

export interface HistoryRoutesOptions {
  db: Db;
}

// eslint-disable-next-line @typescript-eslint/require-await -- fastify async plugin signature
export async function historyRoutes(
  instance: FastifyInstance,
  options: HistoryRoutesOptions,
): Promise<void> {
  const app = instance.withTypeProvider<ZodTypeProvider>();
  const { db } = options;

  app.addHook("preHandler", app.authenticate);

  /** The identity, only if it belongs to the requesting user. */
  async function findOwnedIdentity(identityId: string, userId: string) {
    const [row] = await db
      .select({ id: identities.id })
      .from(identities)
      .innerJoin(flistAccounts, eq(identities.flistAccountId, flistAccounts.id))
      .where(
        and(eq(identities.id, identityId), eq(flistAccounts.userId, userId)),
      )
      .limit(1);
    return row;
  }

  app.get(
    "/:identityId/conversations",
    {
      schema: {
        params: z.object({ identityId: z.uuid() }),
        response: {
          200: z.object({ conversations: z.array(conversationResponse) }),
          404: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const identity = await findOwnedIdentity(
        request.params.identityId,
        request.user.sub,
      );
      if (!identity) {
        return reply.code(404).send({ error: "Identity not found" });
      }
      const rows = await db
        .select({
          id: conversations.id,
          kind: conversations.kind,
          channelKey: conversations.channelKey,
          partnerCharacter: conversations.partnerCharacter,
          title: conversations.title,
          pinned: conversations.pinned,
          joined: conversations.joined,
          lastReadMessageId: conversations.lastReadMessageId,
        })
        .from(conversations)
        .where(eq(conversations.identityId, identity.id))
        .orderBy(conversations.createdAt);
      return reply.send({ conversations: rows });
    },
  );

  app.get(
    "/:identityId/conversations/:conversationId/messages",
    {
      schema: {
        params: z.object({
          identityId: z.uuid(),
          conversationId: z.uuid(),
        }),
        querystring: z.object({
          /** Return messages with id strictly below this cursor. */
          before: z.coerce.number().int().positive().optional(),
          limit: z.coerce.number().int().min(1).max(200).default(50),
        }),
        response: {
          200: z.object({
            messages: z.array(messageResponse),
            hasMore: z.boolean(),
          }),
          404: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const identity = await findOwnedIdentity(
        request.params.identityId,
        request.user.sub,
      );
      if (!identity) {
        return reply.code(404).send({ error: "Identity not found" });
      }
      const [conversation] = await db
        .select({ id: conversations.id })
        .from(conversations)
        .where(
          and(
            eq(conversations.id, request.params.conversationId),
            eq(conversations.identityId, identity.id),
          ),
        )
        .limit(1);
      if (!conversation) {
        return reply.code(404).send({ error: "Conversation not found" });
      }

      const { before, limit } = request.query;
      // limit+1 newest-first tells us whether older history remains; the
      // page itself is returned ascending for direct prepending.
      const page = await db
        .select({
          id: messages.id,
          senderCharacter: messages.senderCharacter,
          kind: messages.kind,
          bbcode: messages.bbcode,
          sentByUs: messages.sentByUs,
          createdAt: messages.createdAt,
        })
        .from(messages)
        .where(
          and(
            eq(messages.conversationId, conversation.id),
            before === undefined ? undefined : lt(messages.id, before),
          ),
        )
        .orderBy(desc(messages.id))
        .limit(limit + 1);
      const hasMore = page.length > limit;
      return reply.send({
        messages: page.slice(0, limit).reverse(),
        hasMore,
      });
    },
  );
}
