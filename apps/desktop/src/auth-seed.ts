/**
 * The handover from the main process's login to the renderer's auth store.
 *
 * ── CONTRACT WITH THE WEB APP ────────────────────────────────────────────────
 * This module writes the web app's *own* persisted-session format. The source
 * of truth is `apps/web/src/stores/auth.ts` (`STORAGE_KEY` and
 * `PersistedAuth`), which this package must not modify (spec invariant 2): the
 * renderer is the unmodified web app, so the shell's only lever is to leave a
 * session where that store already looks for one. `auth-seed.test.ts` pins the
 * shape; if the store's persisted format changes, that test is where it
 * surfaces, and a pointer comment sits beside the store's own definition.
 *
 * Two details of the store's semantics that the seed depends on:
 *
 * - The refresh token is persisted only when "keep me signed in" was chosen.
 *   Seeding *is* that choice — staying signed in is the desktop app's whole
 *   point — so the seed always contains the refresh token, and the store's
 *   `restore()` sets `remember: true` when it adopts one.
 * - `restore()` immediately rotates the seeded refresh token. That is fine and
 *   expected; it also means the seed is good exactly once, which is what
 *   `createSeedDispenser` enforces (see there).
 */

/** Must equal `STORAGE_KEY` in apps/web/src/stores/auth.ts. */
export const AUTH_STORAGE_KEY = "eb.auth";

/** Sync IPC channel the preload uses to fetch the seed. See `preload.cts`. */
export const AUTH_SEED_CHANNEL = "emberchat:auth-seed";

/** Mirrors `UserDto` in apps/web/src/lib/api.ts. */
export interface SeedUser {
  readonly id: string;
  readonly email: string;
  readonly username: string;
}

/** Mirrors `PersistedAuth` in apps/web/src/stores/auth.ts. */
export interface AuthSeed {
  readonly user: SeedUser;
  readonly refreshToken: string;
}

/** What the preload receives over IPC: a localStorage key and its value. */
export interface AuthSeedMessage {
  readonly key: string;
  readonly value: string;
}

/**
 * Narrows a `POST /api/auth/login` response (apps/server auth routes:
 * `{ user, accessToken, refreshToken }`) into the persisted shape. The access
 * token is deliberately dropped — the store keeps it in memory only, and
 * `restore()` mints a fresh one on boot anyway.
 */
export function buildAuthSeed(response: unknown): AuthSeed {
  if (typeof response !== "object" || response === null) {
    throw new Error("the login response was not an object");
  }
  const { user, refreshToken } = response as {
    user?: unknown;
    refreshToken?: unknown;
  };
  if (typeof refreshToken !== "string" || refreshToken === "") {
    throw new Error("the login response carried no refresh token");
  }
  if (typeof user !== "object" || user === null) {
    throw new Error("the login response carried no user");
  }
  const { id, email, username } = user as Partial<SeedUser>;
  if (
    typeof id !== "string" ||
    typeof email !== "string" ||
    typeof username !== "string"
  ) {
    throw new Error("the login response's user was not the expected shape");
  }
  return { user: { id, email, username }, refreshToken };
}

/** The seed as the preload will hand it to `localStorage.setItem`. */
export function authSeedMessage(seed: AuthSeed): AuthSeedMessage {
  return { key: AUTH_STORAGE_KEY, value: JSON.stringify(seed) };
}

export interface SeedDispenser {
  /** The seed, once. Every later caller gets `null`. */
  take(): AuthSeedMessage | null;
}

/**
 * One seed per app boot, handed to whoever asks first.
 *
 * Both halves of that matter. **Once**: the store rotates the seeded refresh
 * token as it boots, so by the time a page reloads the seeded value is spent —
 * writing it again would replace a live token with a dead one and drop the user
 * on the login screen. **Always**: whatever is already in localStorage may be a
 * session from days ago, expired or evicted, and this boot's login is known
 * good — so the first page load of each boot overwrites it rather than gambling
 * on it.
 */
export function createSeedDispenser(message: AuthSeedMessage): SeedDispenser {
  let remaining: AuthSeedMessage | null = message;
  return {
    take() {
      const seed = remaining;
      remaining = null;
      return seed;
    },
  };
}
