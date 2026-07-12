import { createHash, randomBytes } from "node:crypto";

export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days, sliding

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
