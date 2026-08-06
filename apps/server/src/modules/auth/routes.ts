import argon2 from "argon2";
import { and, desc, eq, gt, notInArray, or } from "drizzle-orm";
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

/**
 * How long the pre-rotation refresh token stays redeemable after a rotation.
 * Single-use rotation has a known failure mode: the server commits the new
 * token but the response never reaches the client (the page navigated away
 * with the refresh in flight — diagnosed live in the E2E suite, where every
 * full page load refreshes on boot). The client then holds only the burnt
 * token, and without a grace window that logs the session out. Within the
 * window the old token redeems once more (minting a fresh current token);
 * the window never renews for the same old token, so a stolen pre-rotation
 * token stays useful for seconds, not for the session's life.
 */
export const ROTATION_GRACE_MS = 30_000;

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
    // Evict beyond the cap, stalest first — by lastSeenAt, not createdAt:
    // a long-lived daily-refreshed device is old by creation but the most
    // alive by use, and one-shot logins nobody refreshed should go first
    // (M7 audit backlog). The just-inserted row has lastSeenAt = now.
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
              .orderBy(desc(authSessions.lastSeenAt), desc(authSessions.id))
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
      // old one, so redeeming stays atomic. The replaced hash is kept for
      // ROTATION_GRACE_MS (see there) so a client that never received this
      // response can recover instead of being logged out.
      const { token, hash } = generateRefreshToken();
      let [session] = await db
        .update(authSessions)
        .set({
          refreshTokenHash: hash,
          prevRefreshTokenHash: presentedHash,
          rotatedAt: now,
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
        // Grace path: the presented token was already rotated away — accept
        // it briefly after rotatedAt. prevRefreshTokenHash and rotatedAt stay
        // untouched, so the same old token's window never renews.
        [session] = await db
          .update(authSessions)
          .set({
            refreshTokenHash: hash,
            expiresAt: refreshExpiry(now),
            lastSeenAt: now,
          })
          .where(
            and(
              eq(authSessions.prevRefreshTokenHash, presentedHash),
              gt(
                authSessions.rotatedAt,
                new Date(now.getTime() - ROTATION_GRACE_MS),
              ),
              gt(authSessions.expiresAt, now),
            ),
          )
          .returning({ id: authSessions.id, userId: authSessions.userId });
      }
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
      const presentedHash = hashRefreshToken(request.body.refreshToken);
      // The pre-rotation hash counts too. /refresh accepts it for
      // ROTATION_GRACE_MS precisely because a client can be left holding the
      // older token (the lost-response race, or two tabs sharing one stored
      // token) — and a logout that matched only the current one deleted
      // nothing while answering 204. The row then lived to its 30-day
      // expiry, the outstanding access token kept working, and because push
      // subscriptions cascade off auth_sessions the signed-out browser kept
      // receiving notifications.
      await db
        .delete(authSessions)
        .where(
          or(
            eq(authSessions.refreshTokenHash, presentedHash),
            eq(authSessions.prevRefreshTokenHash, presentedHash),
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
