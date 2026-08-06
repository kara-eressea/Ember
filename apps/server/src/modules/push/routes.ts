// Web Push subscription REST (design/web-push.md §3), shaped like the
// notification-inbox routes: zod type provider, `authenticate` preHandler, a
// per-route rate limit.
//
// Subscriptions are user-scoped but SESSION-owned: the row records the auth
// session that registered it, and the foreign key cascades. That is the whole
// revocation story — logging out deletes the auth_sessions row and the
// endpoint goes with it (invariant 5), so a device that signed out cannot keep
// receiving notifications.

import { z } from "zod";
import { and, asc, eq, inArray } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import type { Db } from "../../db/index.js";
import { pushSubscriptions } from "../../db/schema.js";

export interface PushRoutesOptions {
  db: Db;
  /** The instance's VAPID public key, or undefined when push is unconfigured
   * — which is what `enabled: false` reports. */
  vapidPublicKey?: string;
}

/**
 * Browsers re-PUT their subscription on every boot and rotation, and a
 * multi-tab user does it once per tab. Generous for that, closed to a loop.
 */
const PUSH_RATE_LIMIT_MAX = 60;

/**
 * Installs one login may keep. Phones, desktops, a work machine — ten covers
 * any honest user, so this is an anti-bloat ceiling rather than a cache
 * eviction policy: past it the oldest registration goes, first-registered
 * first. `createdAt` deliberately keeps meaning "first seen" across the
 * upsert, so a device that has been here since the beginning is not aged out
 * by one that merely re-registered more recently. At ten, which endpoint goes
 * is nearly always moot — and a device that loses its row simply re-PUTs on
 * its next boot.
 */
export const MAX_SUBSCRIPTIONS_PER_USER = 10;

/** The browser's `PushSubscription.toJSON()` shape, minus expirationTime. */
const subscriptionBody = z.object({
  // https: only — a push service endpoint is never anything else, and this
  // keeps the send path from being pointed at an arbitrary local address.
  endpoint: z.url({ protocol: /^https$/ }).max(2048),
  keys: z.object({
    p256dh: z.string().min(1).max(255),
    auth: z.string().min(1).max(255),
  }),
});

// eslint-disable-next-line @typescript-eslint/require-await -- fastify async plugin signature
export async function pushRoutes(
  instance: FastifyInstance,
  options: PushRoutesOptions,
): Promise<void> {
  const app = instance.withTypeProvider<ZodTypeProvider>();
  const { db, vapidPublicKey } = options;

  app.addHook("preHandler", app.authenticate);

  /**
   * Feature detection as much as key delivery: `enabled: false` is how the
   * client learns this instance has no VAPID keys and hides the whole
   * control, rather than offering a toggle that could only fail.
   */
  app.get(
    "/vapid-key",
    {
      config: {
        rateLimit: { max: PUSH_RATE_LIMIT_MAX, timeWindow: "1 minute" },
      },
      schema: {
        response: {
          200: z.object({
            enabled: z.boolean(),
            key: z.string().optional(),
          }),
        },
      },
    },
    async (_request, reply) =>
      reply.send(
        vapidPublicKey === undefined
          ? { enabled: false }
          : { enabled: true, key: vapidPublicKey },
      ),
  );

  /**
   * Register (or refresh) this browser's subscription. Upserts on endpoint:
   * a re-subscribe after a rotation, or the same install signing in again,
   * must update the row rather than accumulate duplicates that would each
   * deliver the same notification.
   */
  app.put(
    "/subscription",
    {
      config: {
        rateLimit: { max: PUSH_RATE_LIMIT_MAX, timeWindow: "1 minute" },
      },
      schema: {
        body: subscriptionBody,
        response: {
          200: z.object({ ok: z.literal(true) }),
          404: z.object({ error: z.string() }),
        },
      },
    },
    async (request, reply) => {
      if (vapidPublicKey === undefined) {
        // Nothing could ever be sent to it; refuse rather than store an
        // endpoint this instance will never use (invariant 6).
        return reply.code(404).send({ error: "Push is not configured" });
      }
      const { sub: userId, sid: authSessionId } = request.user;
      await db
        .insert(pushSubscriptions)
        .values({
          userId,
          authSessionId,
          endpoint: request.body.endpoint,
          p256dh: request.body.keys.p256dh,
          auth: request.body.keys.auth,
        })
        .onConflictDoUpdate({
          target: pushSubscriptions.endpoint,
          set: {
            // The endpoint moves to whoever holds it now: a shared browser
            // where a second user signs in must not keep pushing the first
            // user's messages to it.
            userId,
            authSessionId,
            p256dh: request.body.keys.p256dh,
            auth: request.body.keys.auth,
          },
        });
      await enforceCap(userId);
      return reply.send({ ok: true } as const);
    },
  );

  /**
   * Explicit opt-out from one device. Scoped to the requesting user, so an
   * endpoint belonging to somebody else simply matches nothing — and, like
   * the inbox delete, it is idempotent: a second call is a no-op, not a 404.
   */
  app.delete(
    "/subscription",
    {
      config: {
        rateLimit: { max: PUSH_RATE_LIMIT_MAX, timeWindow: "1 minute" },
      },
      schema: {
        body: z.object({ endpoint: z.string().min(1).max(2048) }),
        response: { 200: z.object({ removed: z.boolean() }) },
      },
    },
    async (request, reply) => {
      const removed = await db
        .delete(pushSubscriptions)
        .where(
          and(
            eq(pushSubscriptions.userId, request.user.sub),
            eq(pushSubscriptions.endpoint, request.body.endpoint),
          ),
        )
        .returning({ id: pushSubscriptions.id });
      return reply.send({ removed: removed.length > 0 });
    },
  );

  /** Trim the user back to the cap, oldest first. */
  async function enforceCap(userId: string): Promise<void> {
    const rows = await db
      .select({ id: pushSubscriptions.id })
      .from(pushSubscriptions)
      .where(eq(pushSubscriptions.userId, userId))
      .orderBy(asc(pushSubscriptions.createdAt), asc(pushSubscriptions.id));
    // Guard the under-cap case explicitly: a negative slice length counts
    // back from the end instead of clamping, which would quietly delete
    // live subscriptions from a user who is nowhere near the limit.
    if (rows.length <= MAX_SUBSCRIPTIONS_PER_USER) {
      return;
    }
    const excess = rows.slice(0, rows.length - MAX_SUBSCRIPTIONS_PER_USER);
    await db.delete(pushSubscriptions).where(
      inArray(
        pushSubscriptions.id,
        excess.map((row) => row.id),
      ),
    );
  }
}
