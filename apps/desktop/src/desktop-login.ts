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

export async function loginAppAccount(
  options: LoginOptions,
): Promise<AuthSeed> {
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
      "Could not reach the local bouncer to sign in.",
      { cause },
    );
  }
  if (!response.ok) {
    throw new DesktopLoginError(
      `The local bouncer refused the app account's sign-in (HTTP ${String(response.status)}): ${(await response.text()).slice(0, 500)}`,
    );
  }
  try {
    return buildAuthSeed(await response.json());
  } catch (cause) {
    throw new DesktopLoginError(
      "The local bouncer's sign-in response was not the expected shape.",
      { cause },
    );
  }
}
