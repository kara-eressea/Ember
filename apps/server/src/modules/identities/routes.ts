// Identities CRUD (architecture.md §REST). An identity is one F-List
// character on one of the user's accounts; the IdentityPicker creates them
// and the gateway connects them.

import { and, count, eq, max } from "drizzle-orm";
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import type { Db } from "../../db/index.js";
import { isUniqueViolation } from "../../db/errors.js";
import { flistAccounts, identities } from "../../db/schema.js";
import {
  AccountLockedError,
  FlistAuthError,
  type TicketManagerRegistry,
} from "../flist-api/ticket-manager.js";
import type { GatewayHub } from "../gateway/gateway.js";
import type { HistorySink } from "../history/sink.js";
import { connectIdentity } from "../session-engine/connect-identity.js";
import type { SessionRegistry } from "../session-engine/registry.js";

const identityResponse = z.object({
  id: z.string(),
  flistAccountId: z.string(),
  characterName: z.string(),
  autoConnect: z.boolean(),
  sortOrder: z.number(),
  createdAt: z.date(),
  /** FchatSession status, "offline" when no session exists. */
  sessionStatus: z.string(),
});

const errorResponse = z.object({ error: z.string() });

/**
 * Rail-wide bound, spanning the user's accounts. Keeps the per-hello badge
 * aggregation (one capped count query per identity) and the reorder payload
 * bounded — the reorder body's max mirrors it, so every real rail stays
 * reorderable.
 */
export const MAX_IDENTITIES_PER_USER = 64;

const createBody = z.object({
  flistAccountId: z.uuid(),
  characterName: z.string().min(1).max(64),
});

export interface IdentitiesRoutesOptions {
  db: Db;
  sessions: SessionRegistry;
  tickets: TicketManagerRegistry;
  hub: GatewayHub;
  history: HistorySink;
}

// eslint-disable-next-line @typescript-eslint/require-await -- fastify async plugin signature
export async function identitiesRoutes(
  instance: FastifyInstance,
  options: IdentitiesRoutesOptions,
): Promise<void> {
  const app = instance.withTypeProvider<ZodTypeProvider>();
  const { db, sessions, tickets, hub, history } = options;

  app.addHook("preHandler", app.authenticate);

  app.get(
    "/",
    {
      schema: {
        response: { 200: z.object({ identities: z.array(identityResponse) }) },
      },
    },
    async (request) => {
      const rows = await db
        .select({
          id: identities.id,
          flistAccountId: identities.flistAccountId,
          characterName: identities.characterName,
          autoConnect: identities.autoConnect,
          sortOrder: identities.sortOrder,
          createdAt: identities.createdAt,
        })
        .from(identities)
        .innerJoin(
          flistAccounts,
          eq(identities.flistAccountId, flistAccounts.id),
        )
        .where(eq(flistAccounts.userId, request.user.sub))
        .orderBy(identities.sortOrder, identities.createdAt);
      return {
        identities: rows.map((row) => ({
          ...row,
          sessionStatus: sessions.get(row.id)?.status ?? "offline",
        })),
      };
    },
  );

  app.post(
    "/",
    {
      schema: {
        body: createBody,
        response: {
          201: z.object({ identity: identityResponse }),
          401: errorResponse,
          404: errorResponse,
          409: errorResponse,
          422: errorResponse,
          423: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const { flistAccountId, characterName } = request.body;
      const [account] = await db
        .select()
        .from(flistAccounts)
        .where(
          and(
            eq(flistAccounts.id, flistAccountId),
            eq(flistAccounts.userId, request.user.sub),
          ),
        )
        .limit(1);
      if (!account) {
        return reply.code(404).send({ error: "Account not found" });
      }
      // The character must actually exist on the account — a typo here would
      // otherwise surface much later as an IDN rejection loop.
      try {
        const { characters } = await tickets
          .managerFor(account.id, account.accountName)
          .getTicketWithCharacters();
        if (!characters.includes(characterName)) {
          return reply
            .code(422)
            .send({ error: "Character is not on this account" });
        }
      } catch (error) {
        if (error instanceof AccountLockedError) {
          return reply
            .code(423)
            .send({ error: "Account is locked — re-enter the password" });
        }
        if (error instanceof FlistAuthError) {
          return reply
            .code(401)
            .send({ error: "F-List rejected the stored password" });
        }
        throw error;
      }
      // New identities join the end of the rail. Computed per user (the rail
      // spans accounts); a concurrent create may tie, which the stable
      // (sortOrder, createdAt) read order resolves.
      const [tail] = await db
        .select({ max: max(identities.sortOrder), count: count() })
        .from(identities)
        .innerJoin(
          flistAccounts,
          eq(identities.flistAccountId, flistAccounts.id),
        )
        .where(eq(flistAccounts.userId, request.user.sub));
      if ((tail?.count ?? 0) >= MAX_IDENTITIES_PER_USER) {
        return reply.code(422).send({
          error: `At most ${String(MAX_IDENTITIES_PER_USER)} identities per user`,
        });
      }
      try {
        const [identity] = await db
          .insert(identities)
          .values({
            flistAccountId: account.id,
            characterName,
            // A freshly picked identity's intent is to be online: it counts
            // for unlock auto-connect until an explicit disconnect clears it.
            autoConnect: true,
            sortOrder: (tail?.max ?? -1) + 1,
          })
          .returning();
        return await reply
          .code(201)
          .send({ identity: { ...identity!, sessionStatus: "offline" } });
      } catch (error) {
        if (isUniqueViolation(error)) {
          return reply.code(409).send({ error: "Identity already exists" });
        }
        throw error;
      }
    },
  );

  // Rail reorder: the full identity order in one idempotent replacement.
  // Requires an exact permutation — a stale tab reordering a list that just
  // gained or lost an identity should fail loudly, not scramble sortOrder.
  app.put(
    "/order",
    {
      schema: {
        body: z.object({
          ids: z.array(z.uuid()).min(1).max(MAX_IDENTITIES_PER_USER),
        }),
        response: { 204: z.null(), 422: errorResponse },
      },
    },
    async (request, reply) => {
      const rows = await db
        .select({ id: identities.id })
        .from(identities)
        .innerJoin(
          flistAccounts,
          eq(identities.flistAccountId, flistAccounts.id),
        )
        .where(eq(flistAccounts.userId, request.user.sub));
      const owned = new Set(rows.map((row) => row.id));
      const { ids } = request.body;
      if (
        ids.length !== owned.size ||
        new Set(ids).size !== ids.length ||
        ids.some((id) => !owned.has(id))
      ) {
        return reply
          .code(422)
          .send({ error: "ids must list every identity exactly once" });
      }
      // Rows update in a canonical order (sorted by id), not payload order:
      // two tabs reordering simultaneously would otherwise lock the same
      // rows in opposite orders and deadlock.
      const ranked = ids
        .map((id, index) => ({ id, index }))
        .sort((a, b) => a.id.localeCompare(b.id));
      await db.transaction(async (tx) => {
        for (const { id, index } of ranked) {
          await tx
            .update(identities)
            .set({ sortOrder: index })
            .where(eq(identities.id, id));
        }
      });
      // Every tab re-sorts its rail; duplicates (one per subscribed
      // identity) are idempotent.
      for (const id of ids) {
        hub.broadcast(id, {
          kind: "identities.reordered",
          d: { order: ids },
        });
      }
      return reply.code(204).send(null);
    },
  );

  // The picker's connect (REST twin of the gateway `session.connect` cmd,
  // both through connectIdentity): needed because the shell's connect-on-
  // visit deliberately ignores identities the user explicitly logged off.
  app.post(
    "/:id/connect",
    {
      schema: {
        params: z.object({ id: z.uuid() }),
        response: {
          200: z.object({ identity: identityResponse }),
          404: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const [row] = await db
        .select({
          identity: identities,
          accountId: flistAccounts.id,
          accountName: flistAccounts.accountName,
        })
        .from(identities)
        .innerJoin(
          flistAccounts,
          eq(identities.flistAccountId, flistAccounts.id),
        )
        .where(
          and(
            eq(identities.id, request.params.id),
            eq(flistAccounts.userId, request.user.sub),
          ),
        )
        .limit(1);
      if (!row) {
        return reply.code(404).send({ error: "Identity not found" });
      }
      const session = await connectIdentity(
        { db, sessions, history },
        {
          identityId: row.identity.id,
          character: row.identity.characterName,
          accountId: row.accountId,
          accountName: row.accountName,
        },
      );
      hub.broadcast(row.identity.id, {
        kind: "identity.updated",
        d: { autoConnect: true },
      });
      return reply.send({
        identity: {
          ...row.identity,
          autoConnect: true,
          sessionStatus: session.status,
        },
      });
    },
  );

  // The picker's log-off (M2: sessions outlive tabs, so the picker needs an
  // explicit way to take a character offline — the gateway cmd equivalent
  // for pages without a gateway connection).
  app.post(
    "/:id/disconnect",
    {
      schema: {
        params: z.object({ id: z.uuid() }),
        response: {
          200: z.object({ identity: identityResponse }),
          404: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const [row] = await db
        .select({ id: identities.id })
        .from(identities)
        .innerJoin(
          flistAccounts,
          eq(identities.flistAccountId, flistAccounts.id),
        )
        .where(
          and(
            eq(identities.id, request.params.id),
            eq(flistAccounts.userId, request.user.sub),
          ),
        )
        .limit(1);
      if (!row) {
        return reply.code(404).send({ error: "Identity not found" });
      }
      // Flag first, stop second — a tab with a stale autoConnect mirror
      // would otherwise auto-resurrect the session on the stopped event.
      const [updated] = await db
        .update(identities)
        .set({ autoConnect: false })
        .where(eq(identities.id, row.id))
        .returning();
      hub.broadcast(row.id, {
        kind: "identity.updated",
        d: { autoConnect: false },
      });
      sessions.stop(row.id, "disconnected by user");
      return reply.send({
        identity: {
          ...updated!,
          sessionStatus: sessions.get(row.id)?.status ?? "offline",
        },
      });
    },
  );

  app.delete(
    "/:id",
    {
      schema: {
        params: z.object({ id: z.uuid() }),
        response: { 204: z.null(), 404: errorResponse },
      },
    },
    async (request, reply) => {
      const [row] = await db
        .select({ id: identities.id })
        .from(identities)
        .innerJoin(
          flistAccounts,
          eq(identities.flistAccountId, flistAccounts.id),
        )
        .where(
          and(
            eq(identities.id, request.params.id),
            eq(flistAccounts.userId, request.user.sub),
          ),
        )
        .limit(1);
      if (!row) {
        return reply.code(404).send({ error: "Identity not found" });
      }
      // Deleting cascades to conversations/messages; the F-Chat session (if
      // any) goes first, and gateway connections drop their caches so a
      // stale row can't resurrect the identity.
      sessions.stop(row.id, "identity deleted");
      hub.identityDeleted(row.id);
      await db.delete(identities).where(eq(identities.id, row.id));
      // A connect/unlock racing this delete may have started a session
      // between the stop above and the row vanishing — stop again now that
      // no route can find the identity anymore.
      sessions.stop(row.id, "identity deleted");
      return reply.code(204).send(null);
    },
  );
}
