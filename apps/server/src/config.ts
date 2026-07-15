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
  /** Global per-IP request backstop (requests/minute). The default suits a
   * public deployment; the E2E stack raises it — a whole parallel suite
   * shares one loopback IP. */
  RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(300),
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
   * Message retention policy. "forever" (the default) never deletes
   * anything; age/size policies join in M7 and extend this enum — an
   * unrecognized value is refused at boot rather than silently kept forever.
   */
  RETENTION_POLICY: z.literal("forever").default("forever"),
  /** How often the retention sweep runs (a no-op under "forever"). */
  RETENTION_SWEEP_INTERVAL_MS: z.coerce
    .number()
    .int()
    .min(60_000)
    .default(6 * 60 * 60 * 1000),
});

export type AppConfig = z.infer<typeof configSchema>;

export function loadConfig(
  env: Record<string, string | undefined> = process.env,
): AppConfig {
  return configSchema.parse(env);
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
