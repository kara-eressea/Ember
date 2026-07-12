import { z } from "zod";

// All deployment-specific values — including branding and the IDN
// cname/cversion — come from the environment (decisions.md §5).
const configSchema = z.object({
  DATABASE_URL: z.string().min(1),
  AUTH_SECRET: z.string().min(32, "AUTH_SECRET must be at least 32 characters"),
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  FCHAT_URL: z.url().default("wss://chat.f-list.net/chat2"),
  FLIST_API_URL: z.url().default("https://www.f-list.net"),
  APP_NAME: z.string().default("Emberline"),
  APP_BASE_URL: z.url().default("http://localhost:3000"),
  CLIENT_NAME: z.string().default("Emberline"),
  CLIENT_VERSION: z.string().default("0.0.0"),
  /** Comma-separated browser origins allowed by CORS. */
  CORS_ORIGIN: z.string().optional(),
  /** Requests per minute per IP on the auth endpoints. */
  AUTH_RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(10),
});

export type AppConfig = z.infer<typeof configSchema>;

export function loadConfig(
  env: Record<string, string | undefined> = process.env,
): AppConfig {
  return configSchema.parse(env);
}
