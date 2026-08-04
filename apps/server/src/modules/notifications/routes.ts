// Notification-inbox REST (#467), shaped like the history routes: the same
// ownedIdentity guard and the same keyset cursor idiom — `?before=<id>`
// walks toward older rows. Pages come back NEWEST FIRST here, unlike the
// message pages: the inbox is a dropdown that reads top-down from the most
// recent entry and loads older ones as you scroll down.

import { z } from "zod";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import type { Db } from "../../db/index.js";
import { flistAccounts, identities } from "../../db/schema.js";
import type { GatewayHub } from "../gateway/gateway.js";
import { notificationDto, type NotificationStore } from "./store.js";

const notificationResponse = z.object({
  id: z.number(),
  kind: z.enum(["mention", "friendrequest", "note", "comment"]),
  convId: z.string().optional(),
  messageId: z.number().optional(),
  character: z.string(),
  excerpt: z.string(),
  muted: z.boolean(),
  createdAt: z.string(),
});

const errorResponse = z.object({ error: z.string() });

export interface NotificationRoutesOptions {
  db: Db;
  notifications: NotificationStore;
  /** Fans the moved watermark out, so opening the inbox on one device drops
   * the bell badge on every other one. */
  hub: Pick<GatewayHub, "broadcast">;
}

/**
 * Well above any human's paging, well below a loop's ambitions. The reads are
 * one indexed keyset page each, so this is an anti-abuse ceiling rather than
 * a cost control.
 */
export const NOTIFICATIONS_RATE_LIMIT_MAX = 120;

// eslint-disable-next-line @typescript-eslint/require-await -- fastify async plugin signature
export async function notificationsRoutes(
  instance: FastifyInstance,
  options: NotificationRoutesOptions,
): Promise<void> {
  const app = instance.withTypeProvider<ZodTypeProvider>();
  const { db, notifications, hub } = options;

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
    "/:identityId/notifications",
    {
      config: {
        rateLimit: {
          max: NOTIFICATIONS_RATE_LIMIT_MAX,
          timeWindow: "1 minute",
        },
      },
      schema: {
        params: z.object({ identityId: z.uuid() }),
        querystring: z.object({
          /** Return rows with id strictly below this cursor (older). */
          before: z.coerce.number().int().positive().optional(),
          limit: z.coerce.number().int().min(1).max(100).default(50),
        }),
        response: {
          200: z.object({
            notifications: z.array(notificationResponse),
            hasMore: z.boolean(),
            /** The seen watermark, so a fresh tab renders unseen rows right. */
            lastSeenId: z.number(),
            unseen: z.number(),
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
      const { before, limit } = request.query;
      const page = await notifications.list(identity.id, {
        ...(before === undefined ? {} : { before }),
        limit,
      });
      const lastSeenId = await notifications.lastSeenId(identity.id);
      return reply.send({
        notifications: page.rows.map(notificationDto),
        hasMore: page.hasMore,
        lastSeenId,
        unseen: await notifications.unseenCount(identity.id, lastSeenId),
      });
    },
  );

  app.put(
    "/:identityId/notifications/seen",
    {
      config: {
        rateLimit: {
          max: NOTIFICATIONS_RATE_LIMIT_MAX,
          timeWindow: "1 minute",
        },
      },
      schema: {
        params: z.object({ identityId: z.uuid() }),
        body: z.object({ lastSeenId: z.number().int().min(0) }),
        response: {
          200: z.object({ lastSeenId: z.number(), unseen: z.number() }),
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
      const lastSeenId = await notifications.markSeen(
        identity.id,
        request.body.lastSeenId,
      );
      const unseen = await notifications.unseenCount(identity.id, lastSeenId);
      // Multi-device: the inbox is server-held state like every unread
      // counter, so reading it on one browser must clear the bell on the
      // others rather than leaving them badging what the user just read.
      hub.broadcast(identity.id, {
        kind: "notification.seen",
        d: { lastSeenId, unseen },
      });
      return reply.send({ lastSeenId, unseen });
    },
  );

  /**
   * Drop one entry from the log (#506). Deliberately idempotent — 200 with
   * `removed: false` rather than 404 when the row is already gone: two tabs
   * with the same panel open are exactly the case this exists for, and the
   * second one's delete is a no-op the user should never see an error about.
   * 404 stays reserved for the identity guard, where it means something.
   *
   * A friend-request entry is a LOG LINE here and nothing more: deleting it
   * neither accepts nor declines the request, which keeps living on its own
   * surfaces (#505).
   */
  app.delete(
    "/:identityId/notifications/:notificationId",
    {
      config: {
        rateLimit: {
          max: NOTIFICATIONS_RATE_LIMIT_MAX,
          timeWindow: "1 minute",
        },
      },
      schema: {
        params: z.object({
          identityId: z.uuid(),
          notificationId: z.coerce.number().int().positive(),
        }),
        response: {
          200: z.object({ removed: z.boolean(), unseen: z.number() }),
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
      const removed = await notifications.remove(
        identity.id,
        request.params.notificationId,
      );
      // Recount rather than decrement. The badge is a capped count of rows
      // past the watermark that are allowed to alert, so whether this delete
      // moved it depends on facts (the row's id, its `muted`, the current
      // watermark, the 99 cap) that only the count knows — and a client that
      // guessed would drift a little further with every guess.
      const unseen = await notifications.unseenCount(identity.id);
      if (removed) {
        hub.broadcast(identity.id, {
          kind: "notification.removed",
          d: { id: request.params.notificationId, unseen },
        });
      }
      return reply.send({ removed, unseen });
    },
  );
}
