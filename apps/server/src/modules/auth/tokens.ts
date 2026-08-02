import { createHash, randomBytes } from "node:crypto";

/**
 * Refresh-token life, SLIDING: every rotation restarts the full window (see
 * refreshExpiry's callers), so a device used at all stays signed in and an
 * abandoned one expires 30 days after its last use. One fixed life for every
 * login by decision — the per-login "keep me signed in" server toggle the
 * post-step-9 audit asked for is not being built; the client-side checkbox
 * already decides whether the token is persisted at all.
 */
export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Opaque refresh token. Only its SHA-256 lands in the database, so a leaked
 * dump cannot be replayed as live tokens.
 */
export function generateRefreshToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, hash: hashRefreshToken(token) };
}

export function hashRefreshToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function refreshExpiry(now = new Date()): Date {
  return new Date(now.getTime() + REFRESH_TOKEN_TTL_MS);
}
