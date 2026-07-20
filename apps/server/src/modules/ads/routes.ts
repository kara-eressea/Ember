// Ad-library REST (M10 step 3): GET returns the identity's ads in order,
// PUT replaces the full list — the highlight-rules pattern (idempotent,
// compare-and-set on knownIds → 409, one transaction so a racing PUT
// can't slip between check and replace). Every accepted PUT fans out
// ads.updated on the identity, so other devices' ad managers converge
// without a refetch.

import { and, asc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { putAdsSchema, type AdDto } from "@emberchat/protocol";
import type { Db } from "../../db/index.js";
import { ads, flistAccounts, identities } from "../../db/schema.js";
import type { GatewayHub } from "../gateway/gateway.js";

const adResponse = z.object({
  id: z.string(),
  content: z.string(),
  tags: z.array(z.string()),
  disabled: z.boolean(),
});

const errorResponse = z.object({ error: z.string() });

export interface AdsRoutesOptions {
  db: Db;
  hub: GatewayHub;
}

// eslint-disable-next-line @typescript-eslint/require-await -- fastify async plugin signature
export async function adsRoutes(
  instance: FastifyInstance,
  options: AdsRoutesOptions,
): Promise<void> {
  const app = instance.withTypeProvider<ZodTypeProvider>();
  const { db, hub } = options;

  app.addHook("preHandler", app.authenticate);

  async function ownsIdentity(
    identityId: string,
    userId: string,
  ): Promise<boolean> {
    const [row] = await db
      .select({ id: identities.id })
      .from(identities)
      .innerJoin(flistAccounts, eq(identities.flistAccountId, flistAccounts.id))
      .where(
        and(eq(identities.id, identityId), eq(flistAccounts.userId, userId)),
      )
      .limit(1);
    return row !== undefined;
  }

  async function listAds(identityId: string): Promise<AdDto[]> {
    const rows = await db
      .select({
        id: ads.id,
        content: ads.content,
        tags: ads.tags,
        disabled: ads.disabled,
      })
      .from(ads)
      .where(eq(ads.identityId, identityId))
      .orderBy(asc(ads.sortOrder), asc(ads.id));
    return rows;
  }

  app.get(
    "/:identityId/ads",
    {
      schema: {
        params: z.object({ identityId: z.uuid() }),
        response: {
          200: z.object({ ads: z.array(adResponse) }),
          404: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const { identityId } = request.params;
      if (!(await ownsIdentity(identityId, request.user.sub))) {
        return reply.code(404).send({ error: "Identity not found" });
      }
      return { ads: await listAds(identityId) };
    },
  );

  app.put(
    "/:identityId/ads",
    {
      schema: {
        params: z.object({ identityId: z.uuid() }),
        body: putAdsSchema,
        response: {
          200: z.object({ ads: z.array(adResponse) }),
          404: errorResponse,
          409: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const { identityId } = request.params;
      if (!(await ownsIdentity(identityId, request.user.sub))) {
        return reply.code(404).send({ error: "Identity not found" });
      }
      // Horizon-faithful normalization: trim, drop whitespace-only ads,
      // dedupe tags, tagless → "default".
      const normalized = request.body.ads
        .map((ad) => ({
          content: ad.content.trim(),
          disabled: ad.disabled,
          tags: [
            ...new Set(
              ad.tags.map((tag) => tag.trim()).filter((tag) => tag.length > 0),
            ),
          ],
        }))
        .filter((ad) => ad.content.length > 0)
        .map((ad) => ({
          ...ad,
          tags: ad.tags.length > 0 ? ad.tags : ["default"],
        }));
      const conflicted = await db.transaction(async (tx) => {
        // Serialize PUTs per identity: under READ COMMITTED a plain select
        // can't stop two concurrent replacements from interleaving their
        // inserts (both CAS checks pass on the same snapshot). The advisory
        // lock is transaction-scoped, so it releases on commit/rollback.
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtext(${identityId}))`,
        );
        if (request.body.knownIds !== undefined) {
          const current = await tx
            .select({ id: ads.id })
            .from(ads)
            .where(eq(ads.identityId, identityId));
          const known = new Set(request.body.knownIds);
          if (
            current.length !== known.size ||
            current.some((row) => !known.has(row.id))
          ) {
            return true;
          }
        }
        await tx.delete(ads).where(eq(ads.identityId, identityId));
        if (normalized.length > 0) {
          await tx.insert(ads).values(
            normalized.map((ad, index) => ({
              identityId,
              sortOrder: index,
              ...ad,
            })),
          );
        }
        return false;
      });
      if (conflicted) {
        return reply.code(409).send({
          error: "Ads changed on another device — review the updated list",
        });
      }
      const list = await listAds(identityId);
      hub.broadcast(identityId, { kind: "ads.updated", d: { ads: list } });
      return { ads: list };
    },
  );
}
