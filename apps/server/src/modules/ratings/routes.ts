// Ad-ratings REST (M11 step 2): the user's local ★1–5 + note on other
// posters. Per app user — one rating per rated character, shared across
// all the user's identities — and strictly local: nothing here ever
// reaches F-List. GET lists everything (the client store loads once and
// keys ad rows off it), PUT upserts by character, DELETE clears.

import { asc, and, eq } from "drizzle-orm";
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import {
  FLIST_NAME_RE,
  putRatingSchema,
  type RatingDto,
} from "@emberchat/protocol";
import type { Db } from "../../db/index.js";
import { adRatings } from "../../db/schema.js";

const ratingResponse = z.object({
  character: z.string(),
  score: z.number(),
  note: z.string().optional(),
  updatedAt: z.string(),
});

const errorResponse = z.object({ error: z.string() });

/** F-List names are 1–64 chars of word/space/dash on the wire. */
const characterParam = z
  .string()
  .min(1)
  .max(64)
  .refine((name) => FLIST_NAME_RE.test(name), {
    message: "not a valid character name",
  });

export interface RatingsRoutesOptions {
  db: Db;
}

function toDto(row: {
  character: string;
  score: number;
  note: string | null;
  updatedAt: Date;
}): RatingDto {
  return {
    character: row.character,
    score: row.score,
    ...(row.note !== null && row.note !== "" ? { note: row.note } : {}),
    updatedAt: row.updatedAt.toISOString(),
  };
}

// eslint-disable-next-line @typescript-eslint/require-await -- fastify async plugin signature
export async function ratingsRoutes(
  instance: FastifyInstance,
  options: RatingsRoutesOptions,
): Promise<void> {
  const app = instance.withTypeProvider<ZodTypeProvider>();
  const { db } = options;

  app.addHook("preHandler", app.authenticate);

  app.get(
    "/",
    {
      schema: {
        response: { 200: z.object({ ratings: z.array(ratingResponse) }) },
      },
    },
    async (request) => {
      const rows = await db
        .select({
          character: adRatings.character,
          score: adRatings.score,
          note: adRatings.note,
          updatedAt: adRatings.updatedAt,
        })
        .from(adRatings)
        .where(eq(adRatings.userId, request.user.sub))
        .orderBy(asc(adRatings.characterLower));
      return { ratings: rows.map(toDto) };
    },
  );

  app.put(
    "/:character",
    {
      schema: {
        params: z.object({ character: characterParam }),
        body: putRatingSchema,
        response: {
          200: z.object({ rating: ratingResponse }),
        },
      },
    },
    async (request) => {
      const { character } = request.params;
      const note = request.body.note?.trim();
      const values = {
        userId: request.user.sub,
        characterLower: character.toLowerCase(),
        character,
        score: request.body.score,
        note: note !== undefined && note !== "" ? note : null,
        updatedAt: new Date(),
      };
      const [row] = await db
        .insert(adRatings)
        .values(values)
        .onConflictDoUpdate({
          target: [adRatings.userId, adRatings.characterLower],
          set: {
            character: values.character,
            score: values.score,
            note: values.note,
            updatedAt: values.updatedAt,
          },
        })
        .returning({
          character: adRatings.character,
          score: adRatings.score,
          note: adRatings.note,
          updatedAt: adRatings.updatedAt,
        });
      return { rating: toDto(row!) };
    },
  );

  app.delete(
    "/:character",
    {
      schema: {
        params: z.object({ character: characterParam }),
        response: {
          204: z.null(),
          404: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const deleted = await db
        .delete(adRatings)
        .where(
          and(
            eq(adRatings.userId, request.user.sub),
            eq(
              adRatings.characterLower,
              request.params.character.toLowerCase(),
            ),
          ),
        )
        .returning({ character: adRatings.character });
      if (deleted.length === 0) {
        return reply.code(404).send({ error: "Rating not found" });
      }
      return reply.code(204).send(null);
    },
  );
}
