import { LOOPBACK_HOST, loopbackOrigin } from "./loopback.js";

export interface EmbeddedServerEnvOptions {
  /** The loopback port the shell picked for this boot. */
  readonly port: number;
  /** `<userData>/db` — the pglite data directory. */
  readonly dataDir: string;
  /** Absolute path to the built web app the server serves as the renderer. */
  readonly webDist: string;
  /** JWT signing secret, stable across boots (#301, under safeStorage). */
  readonly authSecret: string;
  /** The shell's version, which becomes the F-Chat IDN `cversion`. */
  readonly clientVersion: string;
  /**
   * Whether the server may run M7's daily release check (#549). The user's own
   * answer, from `config.json` — see `update-check.ts` for why it is read here,
   * at fork time, and therefore only changes on a restart.
   */
  readonly updateCheckEnabled: boolean;
}

/**
 * The complete environment of the embedded server child — deliberately
 * *complete*, not a patch over `process.env`: the desktop shell inherits a
 * user's shell environment, and a stray `DATABASE_URL`, `AUTH_SECRET` or
 * `CORS_ORIGIN` picked up from there would silently reconfigure the bouncer.
 * Everything the server needs is either in here or at its schema default
 * (apps/server/src/config.ts).
 *
 * `APP_BASE_URL` is load-bearing beyond cosmetics: the gateway's origin
 * allowlist is derived from it (app.ts `loopbackAliases`), so this is what
 * admits the renderer's `http://127.0.0.1:<port>` origin to the WebSocket.
 */
export function buildServerEnv(
  options: EmbeddedServerEnvOptions,
): Record<string, string> {
  return {
    NODE_ENV: "production",
    // The embedded database (MX2). PGLITE_DATA_DIR is created if missing.
    DB_DRIVER: "pglite",
    PGLITE_DATA_DIR: options.dataDir,
    // Invariant 3: loopback only, forever.
    HOST: LOOPBACK_HOST,
    PORT: String(options.port),
    APP_BASE_URL: loopbackOrigin(options.port),
    WEB_DIST: options.webDist,
    AUTH_SECRET: options.authSecret,
    // A desktop client's history is the user's own; nothing sweeps it away
    // unless they ask (there is no UI for it yet).
    RETENTION_POLICY: "forever",
    CLIENT_VERSION: options.clientVersion,
    // Always written, both ways round. The server's own default is `true`, so
    // an omitted key would still be correct for the common case — but this
    // environment is deliberately complete (see above), and a switch whose
    // "off" is a missing variable is a switch nobody can read off a log.
    UPDATE_CHECK_ENABLED: options.updateCheckEnabled ? "true" : "false",
  };
}

/**
 * The environment for the one-shot admin CLI child that provisions the app
 * account (#301). Same completeness rule as above, and the same database
 * coordinates — the CLI reads `DB_DRIVER`/`PGLITE_DATA_DIR` straight from the
 * environment rather than through `loadConfig`, so a stray `DATABASE_URL` in a
 * developer's shell would otherwise send it to the wrong database entirely.
 *
 * `AUTH_SECRET` is along for the ride: the CLI has no use for it today, but it
 * is part of "the same env the server gets", and the pair travels together.
 */
export function buildAdminCliEnv(options: {
  readonly dataDir: string;
  readonly authSecret: string;
}): Record<string, string> {
  return {
    NODE_ENV: "production",
    DB_DRIVER: "pglite",
    PGLITE_DATA_DIR: options.dataDir,
    AUTH_SECRET: options.authSecret,
  };
}
