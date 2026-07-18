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
import type { GatewayHub } from "../gateway/gateway.js";
import type { HistorySink } from "../history/sink.js";
import type { SessionRegistry } from "../session-engine/registry.js";
import type { CredentialStore } from "./credential-store.js";
import type { CredentialVault } from "./vault.js";

const accountResponse = z.object({
  id: z.string(),
  accountName: z.string(),
  /** Whether the in-memory vault currently holds this account's password. */
  unlocked: z.boolean(),
  /** Whether an at-rest credential is stored (§15 "Remember" opt-in). */
  remembered: z.boolean(),
  createdAt: z.date(),
});

const errorResponse = z.object({ error: z.string() });

const addAccountBody = z.object({
  accountName: z.string().min(1).max(254),
  // Forwarded to F-List once for verification, then vaulted in memory —
  // never persisted or logged (decisions.md §3)… unless `remember` opts
  // this account into encrypted at-rest storage (§15).
  password: z.string().min(1).max(1024),
  remember: z.boolean().optional(),
});

const unlockBody = z.object({
  password: z.string().min(1).max(1024),
  remember: z.boolean().optional(),
});

const rememberBody = z.object({ remember: z.boolean() });

const idParams = z.object({ id: z.uuid() });

export interface FlistAccountsRoutesOptions {
  db: Db;
  vault: CredentialVault;
  store: CredentialStore;
  tickets: TicketManagerRegistry;
  sessions: SessionRegistry;
  history: HistorySink;
  hub: GatewayHub;
  /**
   * Per-route rate limit for the endpoints that consume a guaranteed slot
   * on the process-wide 1 req/s F-List throttle (add, unlock). Without it,
   * one user hammering unlock queues every other tenant's ticket
   * acquisition behind theirs.
   */
  rateLimitMax: number;
}

// eslint-disable-next-line @typescript-eslint/require-await -- fastify async plugin signature
export async function flistAccountsRoutes(
  instance: FastifyInstance,
  options: FlistAccountsRoutesOptions,
): Promise<void> {
  const app = instance.withTypeProvider<ZodTypeProvider>();
  const { db, vault, store, tickets, sessions, history, hub, rateLimitMax } =
    options;
  const flistRateLimit = {
    rateLimit: { max: rateLimitMax, timeWindow: "1 minute" },
  };

  app.addHook("preHandler", app.authenticate);

  async function findOwnedAccount(id: string, userId: string) {
    const [row] = await db
      .select()
      .from(flistAccounts)
      .where(and(eq(flistAccounts.id, id), eq(flistAccounts.userId, userId)))
      .limit(1);
    return row;
  }

  function present(
    row: { id: string; accountName: string; createdAt: Date },
    remembered: boolean,
  ) {
    return {
      id: row.id,
      accountName: row.accountName,
      unlocked: vault.has(row.id),
      remembered,
      createdAt: row.createdAt,
    };
  }

  app.get(
    "/",
    {
      schema: {
        response: {
          200: z.object({
            accounts: z.array(accountResponse),
            /** False when the server has no CREDENTIALS_KEY — the UI
             * hides the "Remember on this server" affordance entirely. */
            canRemember: z.boolean(),
          }),
        },
      },
    },
    async (request) => {
      const rows = await db
        .select()
        .from(flistAccounts)
        .where(eq(flistAccounts.userId, request.user.sub));
      // Always queried, even key-less: a row stored under a since-removed
      // key must stay visible (and Forget-able) — never silently hidden.
      const stored = await store.storedAccountIds();
      return {
        accounts: rows.map((row) => present(row, stored.has(row.id))),
        canRemember: store.enabled,
      };
    },
  );

  app.post(
    "/",
    {
      config: flistRateLimit,
      schema: {
        body: addAccountBody,
        response: {
          201: z.object({
            account: accountResponse,
            characters: z.array(z.string()),
          }),
          401: errorResponse,
          409: errorResponse,
          502: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const { accountName, password, remember } = request.body;
      let row;
      try {
        [row] = await db
          .insert(flistAccounts)
          .values({ userId: request.user.sub, accountName })
          .returning();
      } catch (error) {
        if (isUniqueViolation(error)) {
          return reply
            .code(409)
            .send({ error: "That F-List account is already added" });
        }
        throw error;
      }
      if (!row) {
        throw new Error("flist_accounts insert returned no row");
      }
      // Verify the password with exactly one ticket fetch (through the
      // manager, like every other ticket acquisition), then keep it vaulted.
      vault.set(row.id, password);
      try {
        const { characters } = await tickets
          .managerFor(row.id, row.accountName)
          .getTicketWithCharacters();
        // Only after F-List verified the password, and only opted-in (§15).
        const remembered = remember === true && store.enabled;
        if (remembered) {
          await store.save(row.id, password);
        }
        return await reply
          .code(201)
          .send({ account: present(row, remembered), characters });
      } catch (error) {
        vault.delete(row.id);
        tickets.drop(row.id);
        await db.delete(flistAccounts).where(eq(flistAccounts.id, row.id));
        if (error instanceof FlistAuthError) {
          return reply
            .code(401)
            .send({ error: "F-List rejected the account name or password" });
        }
        request.log.error({ err: error }, "ticket verification failed");
        return reply.code(502).send({ error: "Could not reach F-List" });
      }
    },
  );

  app.post(
    "/:id/unlock",
    {
      config: flistRateLimit,
      schema: {
        params: idParams,
        body: unlockBody,
        response: {
          200: z.object({
            account: accountResponse,
            /** Identities brought back online by this unlock. */
            reconnected: z.array(z.string()),
          }),
          401: errorResponse,
          404: errorResponse,
          502: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const row = await findOwnedAccount(request.params.id, request.user.sub);
      if (!row) {
        return reply.code(404).send({ error: "Account not found" });
      }
      vault.set(row.id, request.body.password);
      const manager = tickets.managerFor(row.id, row.accountName);
      // A cached ticket must not vouch for a newly entered password.
      manager.invalidate();
      try {
        await manager.getTicket();
      } catch (error) {
        vault.delete(row.id);
        if (error instanceof FlistAuthError) {
          return reply
            .code(401)
            .send({ error: "F-List rejected the password" });
        }
        request.log.error({ err: error }, "unlock verification failed");
        return reply.code(502).send({ error: "Could not reach F-List" });
      }
      // A verified password refreshes an existing stored credential (the
      // opt-in already happened); `remember: true` opts in right here.
      let remembered = false;
      if (store.enabled) {
        const stored = await store.storedAccountIds();
        remembered = stored.has(row.id) || request.body.remember === true;
        if (remembered) {
          await store.save(row.id, request.body.password);
        }
      }
      // One unlock brings every autoConnect identity back (restart recovery,
      // decisions.md §9 scenario 2): resume exactly the channels each was in.
      const wanted = await db
        .select({
          id: identities.id,
          characterName: identities.characterName,
        })
        .from(identities)
        .where(
          and(
            eq(identities.flistAccountId, row.id),
            eq(identities.autoConnect, true),
          ),
        );
      const reconnected: string[] = [];
      for (const identity of wanted) {
        const existing = sessions.get(identity.id);
        if (existing && existing.status !== "stopped") {
          continue; // already online — nothing to recover
        }
        // Best-effort per identity: one failing seed query or start must
        // not 500 a request whose vault unlock (and possibly some session
        // starts) already happened.
        try {
          sessions.start({
            identityId: identity.id,
            character: identity.characterName,
            accountId: row.id,
            accountName: row.accountName,
            seedChannels: await history.channelsForResume(identity.id),
          });
          reconnected.push(identity.id);
        } catch (error) {
          request.log.error(
            { err: error, identityId: identity.id },
            "unlock auto-connect failed for identity",
          );
        }
      }
      return reply.send({ account: present(row, remembered), reconnected });
    },
  );

  // The "Remember on this server" toggle (§15). Enabling requires the
  // vault to hold the password already (add/unlock verified it — this
  // route never sees or re-verifies a password itself); disabling wipes
  // the stored row.
  app.put(
    "/:id/remember",
    {
      schema: {
        params: idParams,
        body: rememberBody,
        response: {
          200: z.object({ account: accountResponse }),
          404: errorResponse,
          409: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const row = await findOwnedAccount(request.params.id, request.user.sub);
      if (!row) {
        return reply.code(404).send({ error: "Account not found" });
      }
      if (request.body.remember) {
        // Only ENABLING needs the key; deleting a stored row must work on
        // a keyless server too — a user who opted in before the admin
        // removed CREDENTIALS_KEY still owns that ciphertext (audit).
        if (!store.enabled) {
          return reply.code(409).send({
            error:
              "This server has no CREDENTIALS_KEY configured — remembering is disabled",
          });
        }
        const password = vault.get(row.id);
        if (password === undefined) {
          return reply
            .code(409)
            .send({ error: "Unlock the account first, then enable this" });
        }
        await store.save(row.id, password);
      } else {
        await store.remove(row.id);
      }
      return reply.send({ account: present(row, request.body.remember) });
    },
  );

  app.get(
    "/:id/characters",
    {
      schema: {
        params: idParams,
        response: {
          200: z.object({ characters: z.array(z.string()) }),
          401: errorResponse,
          404: errorResponse,
          423: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const row = await findOwnedAccount(request.params.id, request.user.sub);
      if (!row) {
        return reply.code(404).send({ error: "Account not found" });
      }
      try {
        const { characters } = await tickets
          .managerFor(row.id, row.accountName)
          .getTicketWithCharacters();
        return await reply.send({ characters });
      } catch (error) {
        if (error instanceof AccountLockedError) {
          return reply
            .code(423)
            .send({ error: "Account is locked — re-enter the password" });
        }
        if (error instanceof FlistAuthError) {
          // The vaulted password went stale (changed on F-List) — drop it.
          vault.delete(row.id);
          return reply
            .code(401)
            .send({ error: "F-List rejected the stored password" });
        }
        throw error;
      }
    },
  );

  app.delete(
    "/:id",
    {
      schema: {
        params: idParams,
        response: { 204: z.null(), 404: errorResponse },
      },
    },
    async (request, reply) => {
      const row = await findOwnedAccount(request.params.id, request.user.sub);
      if (!row) {
        return reply.code(404).send({ error: "Account not found" });
      }
      // The identities FK cascades, so their rows die with the account — the
      // running F-Chat sessions would NOT (zombies until the next re-ticket
      // fails). Stop them and drop the gateway caches first, like the
      // per-identity delete route does.
      const owned = await db
        .select({ id: identities.id })
        .from(identities)
        .where(eq(identities.flistAccountId, row.id));
      for (const identity of owned) {
        sessions.stop(identity.id, "account removed");
        hub.identityDeleted(identity.id);
      }
      await db.delete(flistAccounts).where(eq(flistAccounts.id, row.id));
      vault.delete(row.id);
      tickets.drop(row.id);
      // A connect/unlock racing the delete may have restarted one in between.
      for (const identity of owned) {
        sessions.stop(identity.id, "account removed");
      }
      return reply.code(204).send(null);
    },
  );
}
