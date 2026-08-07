/**
 * The main process signs in to the bouncer it just started, over loopback, and
 * hands the resulting session to the renderer (`auth-seed.ts`).
 *
 * Every boot logs in afresh, which mints a new auth-session row each time. That
 * is intentional and bounded: `MAX_SESSIONS_PER_USER` (25) evicts the stalest
 * rows by `lastSeenAt` on every login (M7 exposure hardening), so a desktop
 * that starts twice a day never accumulates. Reusing a session across boots
 * would mean persisting a refresh token beside the password — more secrets, for
 * a row the server already prunes.
 *
 * The backup (#548) borrows the same door for a different reason: it needs an
 * access token *now*, and the boot's was handed to the renderer, which rotated
 * it immediately (`auth-seed.ts`). So it logs in again, uses the token, and
 * calls `logoutSession` — a session that lives for the length of one download
 * rather than one more row waiting to be evicted.
 */

import { buildAuthSeed, type AuthSeed } from "./auth-seed.js";

export interface LoginOptions {
  readonly origin: string;
  readonly email: string;
  readonly password: string;
  readonly deviceLabel: string;
  readonly timeoutMs?: number;
}

const LOGIN_TIMEOUT_MS = 15_000;

/** Login refused or unreachable — carries the server's own words if it gave any. */
export class DesktopLoginError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message);
    this.name = "DesktopLoginError";
    if (options?.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}

/**
 * A signed-in session, both halves. The seed is what the renderer gets; the
 * access token is what the main process uses for the one call it makes on its
 * own behalf (the backup), and the refresh token is how it hands the session
 * back afterwards.
 */
export interface DesktopSession {
  readonly seed: AuthSeed;
  readonly accessToken: string;
  readonly refreshToken: string;
}

export async function loginAppAccount(
  options: LoginOptions,
): Promise<DesktopSession> {
  let response: Response;
  try {
    response = await fetch(`${options.origin}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: options.email,
        password: options.password,
        deviceLabel: options.deviceLabel,
      }),
      signal: AbortSignal.timeout(options.timeoutMs ?? LOGIN_TIMEOUT_MS),
    });
  } catch (cause) {
    throw new DesktopLoginError(
      [
        "The app couldn't sign you in on this computer.",
        "",
        "Details: the local server did not answer the sign-in request.",
      ].join("\n"),
      { cause },
    );
  }
  if (!response.ok) {
    throw new DesktopLoginError(
      [
        "The app couldn't sign you in on this computer.",
        "",
        `Details: the local server refused the sign-in (HTTP ${String(response.status)}) — ${(await response.text()).slice(0, 500)}`,
      ].join("\n"),
    );
  }
  try {
    const body = (await response.json()) as { accessToken?: unknown };
    const seed = buildAuthSeed(body);
    if (typeof body.accessToken !== "string" || body.accessToken === "") {
      throw new Error("the login response carried no access token");
    }
    return {
      seed,
      accessToken: body.accessToken,
      refreshToken: seed.refreshToken,
    };
  } catch (cause) {
    throw new DesktopLoginError(
      [
        "The app couldn't sign you in on this computer.",
        "",
        "Details: the local server's sign-in reply was not in the expected shape.",
      ].join("\n"),
      { cause },
    );
  }
}

/**
 * Hand a session back — best effort, and deliberately silent about failure.
 *
 * The one caller is the backup, whose work is already done by the time this
 * runs: a logout that does not go through leaves a row the server's own janitor
 * and eviction policy will collect anyway (see the module comment), which is
 * not worth showing anybody a dialog about.
 */
export async function logoutSession(options: {
  readonly origin: string;
  readonly refreshToken: string;
  readonly timeoutMs?: number;
}): Promise<void> {
  try {
    await fetch(`${options.origin}/api/auth/logout`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refreshToken: options.refreshToken }),
      signal: AbortSignal.timeout(options.timeoutMs ?? LOGIN_TIMEOUT_MS),
    });
  } catch (error) {
    console.warn(
      `Could not end the session the backup opened (${error instanceof Error ? error.message : String(error)}).`,
    );
  }
}
