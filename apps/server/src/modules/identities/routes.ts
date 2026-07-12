// Identities CRUD (architecture.md §REST). An identity is one F-List
// character on one of the user's accounts; the IdentityPicker creates them
// and the gateway connects them.

import { and, eq } from "drizzle-orm";
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
import type { SessionRegistry } from "../session-engine/registry.js";

const identityResponse = z.object({
  id: z.string(),
  flistAccountId: z.string(),
  characterName: z.string(),
  autoConnect: z.boolean(),
  sortOrder: z.number(),
  createdAt: z.date(),
});

const errorResponse = z.object({ error: z.string() });

const createBody = z.object({
  flistAccountId: z.uuid(),
  characterName: z.string().min(1).max(64),
});

export interface IdentitiesRoutesOptions {
  db: Db;
  sessions: SessionRegistry;
  tickets: TicketManagerRegistry;
}

// eslint-disable-next-line @typescript-eslint/require-await -- fastify async plugin signature
export async function identitiesRoutes(
  instance: FastifyInstance,
  options: IdentitiesRoutesOptions,
): Promise<void> {
  const app = instance.withTypeProvider<ZodTypeProvider>();
  const { db, sessions, tickets } = options;

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
      return { identities: rows };
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
      try {
        const [identity] = await db
          .insert(identities)
          .values({ flistAccountId: account.id, characterName })
          .returning();
        return await reply.code(201).send({ identity: identity! });
      } catch (error) {
        if (isUniqueViolation(error)) {
          return reply.code(409).send({ error: "Identity already exists" });
        }
        throw error;
      }
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
      // any) goes first.
      sessions.stop(row.id, "identity deleted");
      await db.delete(identities).where(eq(identities.id, row.id));
      return reply.code(204).send(null);
    },
  );
}
