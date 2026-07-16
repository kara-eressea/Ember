import argon2 from "argon2";
import { and, desc, eq, gt, notInArray } from "drizzle-orm";
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import type { Db } from "../../db/index.js";
import { isUniqueViolation } from "../../db/errors.js";
import { appUsers, authSessions } from "../../db/schema.js";
import { ACCESS_TOKEN_TTL } from "../../plugins/auth.js";
import { emailField, passwordField, usernameField } from "./account-fields.js";
import { LoginLockout } from "./lockout.js";
import {
  generateRefreshToken,
  hashRefreshToken,
  refreshExpiry,
} from "./tokens.js";

const userResponse = z.object({
  id: z.string(),
  email: z.string(),
  username: z.string(),
  createdAt: z.date(),
});

const tokenResponse = z.object({
  user: userResponse,
  accessToken: z.string(),
  refreshToken: z.string(),
});

const registerBody = z.object({
  email: emailField,
  username: usernameField,
  password: passwordField,
  deviceLabel: z.string().max(100).optional(),
});

const loginBody = z.object({
  email: z.email().max(254),
  password: z.string().min(1).max(128),
  deviceLabel: z.string().max(100).optional(),
});

const refreshBody = z.object({ refreshToken: z.string().min(1) });

// Verified against when the email is unknown, so login latency does not
// reveal whether an account exists.
const dummyHash = await argon2.hash("emberchat-timing-equalizer");

/**
 * Sessions a user can hold at once; the oldest are evicted on login (M7
 * exposure hardening — without a cap, a leaked credential could mint
 * unbounded rows). Generous for real multi-device use.
 */
export const MAX_SESSIONS_PER_USER = 25;

export interface AuthRoutesOptions {
  db: Db;
  /** Requests per minute per IP on these endpoints. */
  rateLimitMax: number;
  /** Self-service signup; off on admin-only instances (decisions.md §2). */
  registrationEnabled: boolean;
  /** Injectable for tests (controllable clock). */
  lockout?: LoginLockout;
}

// eslint-disable-next-line @typescript-eslint/require-await -- fastify async plugin signature
export async function authRoutes(
  instance: FastifyInstance,
  options: AuthRoutesOptions,
): Promise<void> {
  const app = instance.withTypeProvider<ZodTypeProvider>();
  const { db, rateLimitMax, registrationEnabled } = options;
  const rateLimit = { max: rateLimitMax, timeWindow: "1 minute" };
  // Per-ACCOUNT lockout, complementing the per-IP rate limit: rotating IPs
  // must not buy unlimited guesses at one email.
  const lockout = options.lockout ?? new LoginLockout();

  async function issueSession(
    user: { id: string; email: string; username: string; createdAt: Date },
    deviceLabel: string | undefined,
  ) {
    const { token, hash } = generateRefreshToken();
    const [session] = await db
      .insert(authSessions)
      .values({
        userId: user.id,
        refreshTokenHash: hash,
        deviceLabel: deviceLabel ?? null,
        expiresAt: refreshExpiry(),
      })
      .returning({ id: authSessions.id });
    if (!session) {
      throw new Error("session insert returned no row");
    }
    // Evict beyond the cap, oldest first (keep the newest N — including the
    // row just inserted).
    await db
      .delete(authSessions)
      .where(
        and(
          eq(authSessions.userId, user.id),
          notInArray(
            authSessions.id,
            db
              .select({ id: authSessions.id })
              .from(authSessions)
              .where(eq(authSessions.userId, user.id))
              .orderBy(desc(authSessions.createdAt), desc(authSessions.id))
              .limit(MAX_SESSIONS_PER_USER),
          ),
        ),
      );
    const accessToken = app.jwt.sign(
      { sub: user.id, sid: session.id },
      { expiresIn: ACCESS_TOKEN_TTL },
    );
    return { user, accessToken, refreshToken: token };
  }

  app.post(
    "/register",
    {
      config: { rateLimit },
      schema: {
        body: registerBody,
        response: {
          201: tokenResponse,
          404: z.object({ error: z.string() }),
          409: z.object({ error: z.string() }),
        },
      },
    },
    async (request, reply) => {
      // 404 rather than 403: a disabled endpoint should not advertise
      // itself to the public internet (admin-only instances are the norm).
      if (!registrationEnabled) {
        return reply.code(404).send({ error: "Registration is disabled" });
      }
      const { email, username, password, deviceLabel } = request.body;
      const passwordHash = await argon2.hash(password);
      let user;
      try {
        [user] = await db
          .insert(appUsers)
          .values({ email: email.toLowerCase(), username, passwordHash })
          .returning({
            id: appUsers.id,
            email: appUsers.email,
            username: appUsers.username,
            createdAt: appUsers.createdAt,
          });
      } catch (error) {
        if (isUniqueViolation(error)) {
          return reply
            .code(409)
            .send({ error: "Email or username is already taken" });
        }
        throw error;
      }
      if (!user) {
        throw new Error("user insert returned no row");
      }
      return reply.code(201).send(await issueSession(user, deviceLabel));
    },
  );

  app.post(
    "/login",
    {
      config: { rateLimit },
      schema: {
        body: loginBody,
        response: {
          200: tokenResponse,
          401: z.object({ error: z.string() }),
          429: z.object({ error: z.string() }),
        },
      },
    },
    async (request, reply) => {
      const { email, password, deviceLabel } = request.body;
      const lockedMs = lockout.lockedForMs(email, request.ip);
      if (lockedMs > 0) {
        return reply
          .header("retry-after", String(Math.ceil(lockedMs / 1000)))
          .code(429)
          .send({ error: "Too many failed attempts — try again later" });
      }
      const [user] = await db
        .select()
        .from(appUsers)
        .where(eq(appUsers.email, email.toLowerCase()))
        .limit(1);
      const validPassword = await argon2.verify(
        user?.passwordHash ?? dummyHash,
        password,
      );
      if (!user || !validPassword) {
        // Unknown emails lock out too — diverging here would reveal which
        // accounts exist (same reasoning as the dummy-hash verify above).
        lockout.recordFailure(email, request.ip);
        return reply.code(401).send({ error: "Invalid email or password" });
      }
      lockout.recordSuccess(email, request.ip);
      return reply.send(await issueSession(user, deviceLabel));
    },
  );

  app.post(
    "/refresh",
    {
      config: { rateLimit },
      schema: {
        body: refreshBody,
        response: {
          200: z.object({ accessToken: z.string(), refreshToken: z.string() }),
          401: z.object({ error: z.string() }),
        },
      },
    },
    async (request, reply) => {
      const now = new Date();
      const presentedHash = hashRefreshToken(request.body.refreshToken);
      // Rotation: swap in a new token in the same statement that matches the
      // old one, so a token can never be redeemed twice.
      const { token, hash } = generateRefreshToken();
      const [session] = await db
        .update(authSessions)
        .set({
          refreshTokenHash: hash,
          expiresAt: refreshExpiry(now),
          lastSeenAt: now,
        })
        .where(
          and(
            eq(authSessions.refreshTokenHash, presentedHash),
            gt(authSessions.expiresAt, now),
          ),
        )
        .returning({ id: authSessions.id, userId: authSessions.userId });
      if (!session) {
        return reply
          .code(401)
          .send({ error: "Invalid or expired refresh token" });
      }
      const accessToken = app.jwt.sign(
        { sub: session.userId, sid: session.id },
        { expiresIn: ACCESS_TOKEN_TTL },
      );
      return reply.send({ accessToken, refreshToken: token });
    },
  );

  app.post(
    "/logout",
    { config: { rateLimit }, schema: { body: refreshBody } },
    async (request, reply) => {
      await db
        .delete(authSessions)
        .where(
          eq(
            authSessions.refreshTokenHash,
            hashRefreshToken(request.body.refreshToken),
          ),
        );
      return reply.code(204).send();
    },
  );

  app.get(
    "/me",
    {
      preHandler: app.authenticate,
      schema: {
        response: {
          200: z.object({ user: userResponse }),
          401: z.object({ error: z.string() }),
        },
      },
    },
    async (request, reply) => {
      const [user] = await db
        .select({
          id: appUsers.id,
          email: appUsers.email,
          username: appUsers.username,
          createdAt: appUsers.createdAt,
        })
        .from(appUsers)
        .where(eq(appUsers.id, request.user.sub))
        .limit(1);
      if (!user) {
        return reply.code(401).send({ error: "Unauthorized" });
      }
      return reply.send({ user });
    },
  );
}
