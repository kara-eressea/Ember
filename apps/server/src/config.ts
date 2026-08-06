import { z } from "zod";
import { RECONNECT_FLOOR_MS } from "@emberchat/session-engine";

// The .env.example placeholder. Refusing it at startup means a copied-but-
// unedited env file cannot silently ship a world-readable signing secret.
const PLACEHOLDER_AUTH_SECRET = "dev-only-secret-change-me-0000000000";

// All deployment-specific values come from the environment (decisions.md §5).
// The product name is NOT among them: it is a build-time constant (`APP_NAME`
// in @emberchat/protocol) as of 2026-08-06, and so is the name half of the IDN
// cname. `CLIENT_VERSION` and `APP_BASE_URL` stay here — the version is the
// release build's to set, and the origin genuinely differs per instance.
//
// A self-hoster who still has `APP_NAME=` or `CLIENT_NAME=` in their .env is
// not broken by this: zod objects strip unknown keys, so the value is simply
// ignored from now on (#556).
const configSchema = z.object({
  /**
   * Which storage driver createDb builds (MX2, #298). `node-postgres` is the
   * default and the only one a server should use — a self-hoster never sets
   * this. `pglite` is the desktop client's embedded Postgres, and the package
   * that backs it ships with the desktop bundle, not the server image.
   */
  DB_DRIVER: z.enum(["node-postgres", "pglite"]).default("node-postgres"),
  /** Required under DB_DRIVER=node-postgres (the guard is in loadConfig). */
  DATABASE_URL: z.string().min(1).optional(),
  /** Data directory for the embedded database. Required under DB_DRIVER=pglite. */
  PGLITE_DATA_DIR: z.string().min(1).optional(),
  AUTH_SECRET: z
    .string()
    .min(32, "AUTH_SECRET must be at least 32 characters")
    .refine((secret) => secret !== PLACEHOLDER_AUTH_SECRET, {
      message:
        "AUTH_SECRET is the .env.example placeholder — generate a real one",
    }),
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  FCHAT_URL: z
    .url({ protocol: /^wss?$/ })
    .default("wss://chat.f-list.net/chat2"),
  FLIST_API_URL: z.url().default("https://www.f-list.net"),
  /**
   * Minimum ms between F-List JSON API request starts. The default IS the
   * developer-policy budget (<= 1 request/second) — never lower it against
   * the real F-List. It exists so dev stacks and E2E runs against the
   * local fchat-sim don't serialize on a pointless throttle.
   */
  FLIST_API_MIN_INTERVAL_MS: z.coerce.number().int().min(0).default(1000),
  /**
   * Reconnect backoff overrides — TEST KNOBS ONLY, for E2E runs against the
   * local fchat-sim. Unset = the policy constants (10 s floor, 5 min cap).
   * The >= 10 s floor is developer policy against F-List's server, so a
   * sub-policy floor against the real F-Chat refuses to boot, like the
   * API-interval guard below.
   */
  FCHAT_RECONNECT_FLOOR_MS: z.coerce.number().int().min(50).optional(),
  FCHAT_RECONNECT_CAP_MS: z.coerce.number().int().min(50).optional(),
  /**
   * Campaign-scheduler timing overrides (M11) — TEST KNOBS ONLY, for E2E
   * runs against the local fchat-sim. Unset = the policy constants
   * (12-min floor, jitter, 7.5 s spacing). Sub-policy values against the
   * real F-Chat refuse to boot, like the API-interval guard below.
   */
  CAMPAIGN_TICK_MS: z.coerce.number().int().min(50).optional(),
  CAMPAIGN_BASE_INTERVAL_MS: z.coerce.number().int().min(500).optional(),
  CAMPAIGN_START_JITTER_MS: z.coerce.number().int().min(0).optional(),
  CAMPAIGN_INTERVAL_JITTER_MS: z.coerce.number().int().min(0).optional(),
  CAMPAIGN_SPACING_MS: z.coerce.number().int().min(0).optional(),
  /** Global per-IP request backstop (requests/minute). Generous for a
   * single-tenant instance; the E2E stack raises it — a whole parallel
   * suite shares one loopback IP. */
  RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(300),
  /**
   * Self-service signup. Off by default — instances are admin-only
   * (decisions.md §2); accounts are created with the admin CLI
   * (`node dist/cli/admin.js`). Dev and test stacks may enable it.
   */
  REGISTRATION_ENABLED: z.stringbool().default(false),
  APP_BASE_URL: z.url().default("http://localhost:3000"),
  /**
   * Absolute path to the built web app (apps/web/dist). When set, the server
   * serves the SPA alongside the API — the production mode (M1 step 11).
   * Unset in development, where Vite serves the web app itself.
   */
  WEB_DIST: z.string().optional(),
  /** The IDN `cversion`; the `cname` half is the frozen APP_NAME (#556). */
  CLIENT_VERSION: z.string().default("0.0.0"),
  /**
   * Daily update check against the GitHub Releases API — a quiet "update
   * available" hint in the UI. The check reveals the instance's existence
   * to GitHub, nothing more; set false to disable the phone-home entirely.
   */
  UPDATE_CHECK_ENABLED: z.stringbool().default(true),
  /** GitHub repo the update check reads releases from. */
  UPDATE_CHECK_REPO: z
    .string()
    .regex(/^[\w.-]+\/[\w.-]+$/)
    .default("kara-eressea/Ember"),
  /**
   * One-boot acknowledgment for migrations flagged in drizzle/breaking.json
   * — the upgrade gate refuses them otherwise. Back up first; remove the
   * flag after the upgrade.
   */
  CONFIRM_BREAKING_UPGRADE: z.stringbool().default(false),
  /** Comma-separated browser origins allowed by CORS. */
  CORS_ORIGIN: z.string().optional(),
  /** Requests per minute per IP on the auth endpoints. */
  AUTH_RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(10),
  /**
   * Fastify trustProxy setting. Unset means "no proxy" (client IPs are taken
   * from the socket). Behind nginx/traefik this MUST be set, or rate limits
   * key on the proxy's address — one shared bucket for every client.
   * Accepts: "true"/"false", a hop count, or comma-separated addresses/CIDRs.
   */
  TRUST_PROXY: z.string().optional(),
  /**
   * Message retention policy: how long history stays before the sweep
   * deletes it. An unrecognized value is refused at boot rather than
   * silently kept forever.
   */
  RETENTION_POLICY: z.enum(["forever", "30d", "90d", "1y"]).default("forever"),
  /** How often the retention sweep runs (a no-op under "forever"). */
  RETENTION_SWEEP_INTERVAL_MS: z.coerce
    .number()
    .int()
    .min(60_000)
    .default(6 * 60 * 60 * 1000),
  /**
   * At-rest F-List credential storage key (M9, decisions.md §15): 32
   * bytes, base64url — generate like AUTH_SECRET. Unset = the "Remember
   * on this server" feature is hidden and nothing is ever stored. The key
   * lives only in the env file: DB dumps/backups alone stay ciphertext.
   * This protects backups, NOT a full-box compromise — the desktop-client
   * guarantee, stated plainly in docs/self-hosting.md.
   */
  CREDENTIALS_KEY: z.preprocess(
    // docker-compose passes `${CREDENTIALS_KEY:-}` — empty means unset.
    (value) => (value === "" ? undefined : value),
    z
      .string()
      .superRefine((key, ctx) => {
        // Node's base64url decoding skips invalid characters rather than
        // erroring, so the only realistic failure is a wrong-length key
        // (hex output, truncated/doubled paste). Say what we decoded —
        // byte counts, never the key itself.
        const bytes = Buffer.from(key, "base64url").length;
        if (bytes !== 32) {
          ctx.addIssue({
            code: "custom",
            message:
              `CREDENTIALS_KEY must decode to exactly 32 bytes of base64url; ` +
              `got a ${key.length}-character value decoding to ${bytes} bytes ` +
              `(expected 43 characters — hex keys decode to 48 bytes and won't work). ` +
              `Generate one: node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`,
          });
        }
      })
      .optional(),
  ),
  /**
   * Disconnect a session from F-Chat after this many hours with zero
   * attached devices (0 = never; decisions.md §15). Courtesy toward
   * F-List: a bouncer nobody reads shouldn't hold a connection forever.
   * The in-memory vault keeps the credentials, so the next attach
   * reconnects automatically with the exact channel set.
   */
  DETACHED_DISCONNECT_HOURS: z.coerce.number().int().min(0).default(72),
  /**
   * Character-data-class requests allowed per sliding hour (M8 profiles).
   * F-List's published limit is 200/hour; the 170 default leaves headroom —
   * do not raise this above the current published limit. Operator-only on
   * purpose (no UI preference): the policy risk attaches to the server's IP
   * and F-List account.
   */
  CHARACTER_DATA_BUDGET_PER_HOUR: z.coerce.number().int().min(1).default(170),
  /** How long a cached character profile stays fresh before a view refetches
   * it (stale rows are still served when the budget is exhausted). */
  PROFILE_CACHE_TTL_MS: z.coerce
    .number()
    .int()
    .min(0)
    .default(24 * 60 * 60 * 1000),
  /** Bulk mapping-list refresh window (ticketless, cheap, drifts rarely). */
  FLIST_MAPPINGS_TTL_MS: z.coerce
    .number()
    .int()
    .min(60_000)
    .default(7 * 24 * 60 * 60 * 1000),
  /** Eicon index host (M8): bulk base.doc + DeltaSince fetches — search
   * text never leaves this server. Tests point it at fchat-sim. */
  EICON_INDEX_BASE_URL: z.url().default("https://xariah.net"),
  /** Delta-refresh cadence for the eicon index (~daily upstream). */
  EICON_INDEX_REFRESH_MS: z.coerce
    .number()
    .int()
    .min(60_000)
    .default(24 * 60 * 60 * 1000),
  /**
   * Web Push VAPID keypair (design/web-push.md §2). All three PUSH_VAPID_*
   * vars are set together or not at all (guard in loadConfig); unset means
   * push is invisible end-to-end — no sender, no routes advertising it, no
   * client UI. The private key signs the JWT that identifies this instance
   * to the push services; it never encrypts anything (payloads are encrypted
   * to the browser's own keys, RFC 8291).
   */
  PUSH_VAPID_PUBLIC_KEY: vapidKey("PUSH_VAPID_PUBLIC_KEY", 65),
  PUSH_VAPID_PRIVATE_KEY: vapidKey("PUSH_VAPID_PRIVATE_KEY", 32),
  /**
   * Contact for the push services when a subscription misbehaves — they
   * require it in the VAPID claim. `mailto:` address or an `https:` URL.
   */
  PUSH_VAPID_SUBJECT: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.string().optional(),
  ),
});

/**
 * One of the two VAPID keys: base64url of an exact byte length (65 for the
 * uncompressed P-256 public point, 32 for the private scalar). Same shape as
 * CREDENTIALS_KEY — `""` is unset so docker-compose's `${VAR:-}` passthrough
 * reads as absent, and the message names what we decoded rather than the key.
 */
function vapidKey(name: string, bytes: number) {
  return z.preprocess(
    (value) => (value === "" ? undefined : value),
    z
      .string()
      .superRefine((key, ctx) => {
        // Node's base64url decoder skips invalid characters instead of
        // failing, so a wrong length is the only signal a paste went wrong.
        const decoded = Buffer.from(key, "base64url").length;
        if (decoded !== bytes) {
          ctx.addIssue({
            code: "custom",
            message:
              `${name} must decode to exactly ${String(bytes)} bytes of base64url; ` +
              `got a ${String(key.length)}-character value decoding to ${String(decoded)} bytes. ` +
              `Generate a keypair: npx web-push generate-vapid-keys`,
          });
        }
      })
      .optional(),
  );
}

export type AppConfig = z.infer<typeof configSchema>;

/** True for f-list.net itself and any subdomain — never for a lookalike
 * host that merely ends in the same characters. */
function isFlistHost(url: string): boolean {
  const hostname = new URL(url).hostname;
  return hostname === "f-list.net" || hostname.endsWith(".f-list.net");
}

export function loadConfig(
  env: Record<string, string | undefined> = process.env,
): AppConfig {
  const config = configSchema.parse(env);
  // The storage driver's setting is required, but which setting depends on
  // the driver — so the requirement is a cross-field guard rather than a
  // schema `.min(1)`. Unset DB_DRIVER still means "DATABASE_URL or refuse to
  // boot", exactly as before.
  if (
    config.DB_DRIVER === "node-postgres" &&
    config.DATABASE_URL === undefined
  ) {
    throw new Error(
      "DATABASE_URL must be set — it is where the server's Postgres lives (DB_DRIVER defaults to node-postgres). See apps/server/.env.example",
    );
  }
  if (config.DB_DRIVER === "pglite" && config.PGLITE_DATA_DIR === undefined) {
    throw new Error(
      "PGLITE_DATA_DIR must be set when DB_DRIVER=pglite — the embedded database needs a directory to live in (it is created if missing)",
    );
  }
  // Guardrail, not just documentation: the sub-budget interval exists for
  // local fchat-sim stacks only. Refusing to boot beats silently violating
  // the F-List developer policy in production (M6 audit).
  if (
    config.FLIST_API_MIN_INTERVAL_MS < 1000 &&
    isFlistHost(config.FLIST_API_URL)
  ) {
    throw new Error(
      "FLIST_API_MIN_INTERVAL_MS below 1000 is only allowed against a local fchat-sim, never the real F-List API",
    );
  }
  // Same guardrail for the reconnect backoff: the >= 10 s floor is policy
  // against F-List's server, so only a sim stack may shorten it.
  if (
    config.FCHAT_RECONNECT_FLOOR_MS !== undefined &&
    config.FCHAT_RECONNECT_FLOOR_MS < RECONNECT_FLOOR_MS &&
    isFlistHost(config.FCHAT_URL)
  ) {
    throw new Error(
      `FCHAT_RECONNECT_FLOOR_MS below ${String(RECONNECT_FLOOR_MS)} is only allowed against a local fchat-sim, never the real F-Chat`,
    );
  }
  // Same guardrail for the campaign schedule: shrunken rotation timings
  // exist for sim-backed test stacks only, never against the real F-Chat.
  const campaignShrunk =
    (config.CAMPAIGN_BASE_INTERVAL_MS !== undefined &&
      config.CAMPAIGN_BASE_INTERVAL_MS < 12 * 60_000) ||
    (config.CAMPAIGN_SPACING_MS !== undefined &&
      config.CAMPAIGN_SPACING_MS < 7_500) ||
    // Zeroed jitter = metronomic posting; the "never looks mechanical"
    // posture is as binding as the floors (audit).
    (config.CAMPAIGN_INTERVAL_JITTER_MS !== undefined &&
      config.CAMPAIGN_INTERVAL_JITTER_MS < 10 * 60_000) ||
    (config.CAMPAIGN_START_JITTER_MS !== undefined &&
      config.CAMPAIGN_START_JITTER_MS < 3 * 60_000);
  if (campaignShrunk && isFlistHost(config.FCHAT_URL)) {
    throw new Error(
      "CAMPAIGN_* timings below the policy floors are only allowed against a local fchat-sim, never the real F-Chat",
    );
  }
  // Web Push is all-three-or-none: a half-configured keypair would boot a
  // server that advertises push and then fails every send, which is a worse
  // outcome than refusing to start. Unset is a first-class answer — the
  // feature simply does not exist on that instance.
  const vapidSet = [
    config.PUSH_VAPID_PUBLIC_KEY,
    config.PUSH_VAPID_PRIVATE_KEY,
    config.PUSH_VAPID_SUBJECT,
  ].filter((value) => value !== undefined).length;
  if (vapidSet !== 0 && vapidSet !== 3) {
    throw new Error(
      "PUSH_VAPID_PUBLIC_KEY, PUSH_VAPID_PRIVATE_KEY and PUSH_VAPID_SUBJECT must all be set together (or all left unset to disable web push). Generate a keypair: npx web-push generate-vapid-keys",
    );
  }
  if (
    config.PUSH_VAPID_SUBJECT !== undefined &&
    !/^(mailto:|https:\/\/)/.test(config.PUSH_VAPID_SUBJECT)
  ) {
    throw new Error(
      "PUSH_VAPID_SUBJECT must be a mailto: address or an https:// URL — the push services reject anything else",
    );
  }
  return config;
}

/** Translates TRUST_PROXY into the value Fastify's trustProxy option takes. */
export function trustProxyValue(
  raw: string | undefined,
): boolean | number | string | string[] {
  if (raw === undefined || raw === "" || raw === "false") {
    return false;
  }
  if (raw === "true") {
    return true;
  }
  if (/^\d+$/.test(raw)) {
    return Number(raw);
  }
  if (raw.includes(",")) {
    return raw.split(",").map((part) => part.trim());
  }
  return raw;
}
