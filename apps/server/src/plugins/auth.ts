import fastifyJwt from "@fastify/jwt";
import fp from "fastify-plugin";
import { and, eq, gt } from "drizzle-orm";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Db } from "../db/index.js";
import { authSessions } from "../db/schema.js";

declare module "@fastify/jwt" {
  interface FastifyJWT {
    payload: { sub: string; sid: string };
    user: { sub: string; sid: string };
  }
}

declare module "fastify" {
  interface FastifyInstance {
    authenticate: (
      request: FastifyRequest,
      reply: FastifyReply,
    ) => Promise<void>;
  }
}

export const ACCESS_TOKEN_TTL = "15m";

/** Registers JWT signing/verification and the `authenticate` route guard. */
export const authPlugin = fp<{ secret: string; db: Db }>(
  async (app, options) => {
    await app.register(fastifyJwt, { secret: options.secret });
    app.decorate(
      "authenticate",
      async (request: FastifyRequest, reply: FastifyReply) => {
        try {
          await request.jwtVerify();
        } catch {
          return reply.code(401).send({ error: "Unauthorized" });
        }
        // Access tokens die with their session: a logout (or session expiry)
        // revokes outstanding tokens immediately, not after the 15-min TTL.
        const [session] = await options.db
          .select({ id: authSessions.id })
          .from(authSessions)
          .where(
            and(
              eq(authSessions.id, request.user.sid),
              gt(authSessions.expiresAt, new Date()),
            ),
          )
          .limit(1);
        if (!session) {
          return reply.code(401).send({ error: "Unauthorized" });
        }
      },
    );
  },
);
