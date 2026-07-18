import { z } from "zod";

// The .env.example placeholder. Refusing it at startup means a copied-but-
// unedited env file cannot silently ship a world-readable signing secret.
const PLACEHOLDER_AUTH_SECRET = "dev-only-secret-change-me-0000000000";

// All deployment-specific values — including branding and the IDN
// cname/cversion — come from the environment (decisions.md §5).
const configSchema = z.object({
  DATABASE_URL: z.string().min(1),
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
  APP_NAME: z.string().default("EmberChat"),
  APP_BASE_URL: z.url().default("http://localhost:3000"),
  /**
   * Absolute path to the built web app (apps/web/dist). When set, the server
   * serves the SPA alongside the API — the production mode (M1 step 11).
   * Unset in development, where Vite serves the web app itself.
   */
  WEB_DIST: z.string().optional(),
  CLIENT_NAME: z.string().default("EmberChat"),
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
  CREDENTIALS_KEY: z
    .string()
    .refine(
      (key) => {
        try {
          return Buffer.from(key, "base64url").length === 32;
        } catch {
          return false;
        }
      },
      { message: "CREDENTIALS_KEY must be 32 bytes of base64url" },
    )
    .optional(),
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
});

export type AppConfig = z.infer<typeof configSchema>;

export function loadConfig(
  env: Record<string, string | undefined> = process.env,
): AppConfig {
  const config = configSchema.parse(env);
  // Guardrail, not just documentation: the sub-budget interval exists for
  // local fchat-sim stacks only. Refusing to boot beats silently violating
  // the F-List developer policy in production (M6 audit).
  if (
    config.FLIST_API_MIN_INTERVAL_MS < 1000 &&
    new URL(config.FLIST_API_URL).hostname.endsWith("f-list.net")
  ) {
    throw new Error(
      "FLIST_API_MIN_INTERVAL_MS below 1000 is only allowed against a local fchat-sim, never the real F-List API",
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
