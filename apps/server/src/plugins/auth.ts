import fastifyJwt from "@fastify/jwt";
import fp from "fastify-plugin";
import type { FastifyReply, FastifyRequest } from "fastify";

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
export const authPlugin = fp<{ secret: string }>(async (app, options) => {
  await app.register(fastifyJwt, { secret: options.secret });
  app.decorate(
    "authenticate",
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        await request.jwtVerify();
      } catch {
        await reply.code(401).send({ error: "Unauthorized" });
      }
    },
  );
});
