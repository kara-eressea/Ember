import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  authSeedMessage,
  buildAuthSeed,
  createSeedDispenser,
  AUTH_SEED_CHANNEL,
  AUTH_STORAGE_KEY,
} from "./auth-seed.js";

/**
 * ── THE PINNED FIXTURE ───────────────────────────────────────────────────────
 * Exactly what `apps/web/src/stores/auth.ts` writes to `localStorage["eb.auth"]`
 * when a session persists — key name and `PersistedAuth` shape, copied by hand
 * from that file (a pointer comment sits beside its definition there). The
 * desktop shell's seed has to be indistinguishable from a session the web app
 * saved itself, because the store's `restore()` reads it without knowing where
 * it came from.
 *
 * If the web store changes its key or its persisted shape, this fixture is
 * where it must fail. Update both sides together or the desktop app silently
 * goes back to showing a login screen.
 */
const WEB_STORE_CONTRACT = {
  storageKey: "eb.auth",
  persisted: {
    user: {
      id: "u1",
      email: "desktop@emberchat.localhost",
      username: "desktop",
    },
    refreshToken: "refresh-token-value",
  },
};

/** A `POST /api/auth/login` 200 (apps/server/src/modules/auth/routes.ts). */
const LOGIN_RESPONSE = {
  user: {
    id: "u1",
    email: "desktop@emberchat.localhost",
    username: "desktop",
    // The route returns this; `UserDto` in the web client does not declare it,
    // so the seed drops it rather than inventing a field the store never had.
    createdAt: "2026-08-05T10:00:00.000Z",
  },
  accessToken: "access-token-value",
  refreshToken: "refresh-token-value",
};

describe("the auth seed", () => {
  it("writes the web store's key", () => {
    expect(AUTH_STORAGE_KEY).toBe(WEB_STORE_CONTRACT.storageKey);
  });

  it("produces exactly the web store's persisted shape", () => {
    const seed = buildAuthSeed(LOGIN_RESPONSE);
    expect(seed).toEqual(WEB_STORE_CONTRACT.persisted);
    const message = authSeedMessage(seed);
    expect(message.key).toBe(WEB_STORE_CONTRACT.storageKey);
    expect(JSON.parse(message.value)).toEqual(WEB_STORE_CONTRACT.persisted);
  });

  it("carries the refresh token, because seeding is 'keep me signed in'", () => {
    // The store persists a refresh token only when the user asked to stay
    // signed in; on the desktop that choice is the product.
    expect(buildAuthSeed(LOGIN_RESPONSE).refreshToken).toBe(
      "refresh-token-value",
    );
  });

  it("keeps the access token out of storage", () => {
    expect(authSeedMessage(buildAuthSeed(LOGIN_RESPONSE)).value).not.toContain(
      "access-token-value",
    );
  });

  it.each([
    ["not an object", "nope"],
    ["missing the user", { accessToken: "a", refreshToken: "r" }],
    ["missing the refresh token", { user: LOGIN_RESPONSE.user }],
    ["a user of the wrong shape", { user: { id: 1 }, refreshToken: "r" }],
  ])("refuses a login response %s", (_label, response) => {
    expect(() => buildAuthSeed(response)).toThrow();
  });
});

describe("the preload", () => {
  const source = readFileSync(
    fileURLToPath(new URL("preload.cts", import.meta.url)),
    "utf8",
  );

  // The preload is CommonJS and cannot import this module, so the channel name
  // is spelled twice. This is the seam that keeps the two spellings equal.
  it("asks on the same IPC channel main answers on", () => {
    expect(source).toContain(`"${AUTH_SEED_CHANNEL}"`);
  });

  it("writes whatever the dispenser gave it, and asks before the page runs", () => {
    // Synchronous by necessity: the page's own scripts read localStorage the
    // moment they start. The once-per-boot guard lives in the dispenser, so
    // the preload itself writes unconditionally.
    expect(source).toContain("sendSync");
    expect(source).toContain("localStorage.setItem(seed.key, seed.value)");
  });

  it("keeps the token off the window and off the command line", () => {
    // No bridge to the page, and nothing read out of argv (where `ps` would
    // see a live refresh token).
    expect(source).not.toContain("contextBridge");
    expect(source).not.toContain("process.argv");
  });
});

describe("the seed dispenser", () => {
  const message = { key: AUTH_STORAGE_KEY, value: "{}" };

  it("hands out this boot's seed exactly once", () => {
    const dispenser = createSeedDispenser(message);
    expect(dispenser.take()).toEqual(message);
    // A reload must not get it again: by then the store has rotated the token
    // away, and re-writing the spent one would sign the user out.
    expect(dispenser.take()).toBe(null);
    expect(dispenser.take()).toBe(null);
  });
});
