// MX2 SPIKE CODE — not part of the build. See README.md in this directory.
//
// Boots the REAL server (`buildApp`) against pglite: upgrade gate, all
// drizzle migrations, REST round trips, the one raw-SQL read, jsonb, and the
// partial+expression unique index.
//
// Copy this file to apps/server/ and run it from there (see README):
//   node boot.mjs [dataDir]

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { fileURLToPath } from "node:url";
import { buildApp } from "./dist/app.js";
import { loadConfig } from "./dist/config.js";
import * as schema from "./dist/db/schema.js";
import { identityBadgeTotals } from "./dist/modules/gateway/snapshot.js";
import {
  assertUpgradeSafe,
  loadUpgradeManifest,
} from "./dist/db/upgrade-gate.js";

const MIGRATIONS = fileURLToPath(new URL("./drizzle", import.meta.url));
const dataDir = process.argv[2];

const t0 = Date.now();
const client = await PGlite.create(dataDir ? { dataDir } : {});
console.log("[boot] PGlite.create ms:", Date.now() - t0, dataDir ?? "(memory)");

const db = drizzle(client, { schema, casing: "snake_case" });

// The upgrade gate wants "anything with pg's query shape". PGlite has it —
// no adapter needed.
const tGate = Date.now();
await assertUpgradeSafe({
  pool: client,
  manifest: await loadUpgradeManifest(MIGRATIONS),
  confirmBreaking: false,
  releasesUrl: "https://example.test/releases",
});
console.log("[boot] upgrade gate ms:", Date.now() - tGate);

const tMig = Date.now();
await migrate(db, { migrationsFolder: MIGRATIONS });
console.log("[boot] migrate (all 22) ms:", Date.now() - tMig);

const tApp = Date.now();
const app = await buildApp({
  config: loadConfig({
    DATABASE_URL: "pglite://spike",
    AUTH_SECRET: "spike-secret-0123456789abcdef0123456789",
    AUTH_RATE_LIMIT_MAX: "1000",
    REGISTRATION_ENABLED: "true",
    FCHAT_URL: "ws://127.0.0.1:9/unused",
    FLIST_API_URL: "http://127.0.0.1:9",
  }),
  db,
  logger: false,
});
console.log("[boot] buildApp ms:", Date.now() - tApp);
console.log("[boot] TOTAL cold boot ms:", Date.now() - t0);

const health = await app.inject({ method: "GET", url: "/healthz" });
console.log("[http] GET /healthz ->", health.statusCode, health.body);

// Register: argon2 + an INSERT that relies on the SQL-side uuidv7() default
// (drizzle omits the id column entirely, so the DB must supply it).
const reg = await app.inject({
  method: "POST",
  url: "/api/auth/register",
  payload: {
    email: "spike@example.test",
    username: "spike",
    password: "hunter2hunter2",
  },
});
console.log("[http] POST /api/auth/register ->", reg.statusCode);
const token = JSON.parse(reg.body).accessToken;
const userRow = await client.query("select id, email from app_users");
console.log("[db] app_users (note the v7 id):", JSON.stringify(userRow.rows));

const me = await app.inject({
  method: "GET",
  url: "/api/auth/me",
  headers: { authorization: `Bearer ${token}` },
});
console.log("[http] GET /api/auth/me ->", me.statusCode);

// Highlight rules: another uuidv7() default, plus the RE2 422 path.
const rule = await app.inject({
  method: "PUT",
  url: "/api/highlight-rules",
  headers: { authorization: `Bearer ${token}` },
  payload: { rules: [{ kind: "word", pattern: "amber" }] },
});
console.log("[http] PUT /api/highlight-rules ->", rule.statusCode, rule.body);

const bad = await app.inject({
  method: "PUT",
  url: "/api/highlight-rules",
  headers: { authorization: `Bearer ${token}` },
  payload: { rules: [{ kind: "regex", pattern: "(?<=foo)bar" }] },
});
console.log("[http] PUT /api/highlight-rules (RE2-refused) ->", bad.statusCode);

// The one raw-SQL read in the codebase (gateway/snapshot.ts `db.execute`) —
// a CROSS JOIN LATERAL with a FILTER aggregate, and the place where the two
// drivers' result types diverge.
const [acct] = (
  await client.query(
    "insert into flist_accounts (user_id, account_name) values ($1,'acct') returning id",
    [userRow.rows[0].id],
  )
).rows;
const [ident] = (
  await client.query(
    "insert into identities (flist_account_id, character_name) values ($1,'Amber Vale') returning id",
    [acct.id],
  )
).rows;
const [conv] = (
  await client.query(
    "insert into conversations (identity_id, kind, channel_key, title) values ($1,'channel','Frontpage','Frontpage') returning id",
    [ident.id],
  )
).rows;
for (const [body, mention] of [
  ["plain one", false],
  ["you were mentioned, amber", true],
  ["plain two", false],
]) {
  await client.query(
    "insert into messages (conversation_id, sender_character, kind, bbcode, mention) values ($1,'Nyx','msg',$2,$3)",
    [conv.id, body, mention],
  );
}
console.log(
  "[db] identityBadgeTotals (raw db.execute path):",
  JSON.stringify(await identityBadgeTotals(db, ident.id)),
);

// jsonb round-trip + the operators the prefs cache uses.
await client.query(
  "insert into user_preferences (user_id, prefs) values ($1, $2::jsonb)",
  [userRow.rows[0].id, JSON.stringify({ theme: "dark", ownNick: true })],
);
const jb = await client.query(
  "select prefs->>'theme' theme, jsonb_typeof(prefs) t, prefs || '{\"extra\":1}'::jsonb merged from user_preferences",
);
console.log("[db] jsonb:", JSON.stringify(jb.rows));

// The partial + expression unique index (conversations_identity_partner_uniq
// on lower(partner_character) WHERE kind='pm') — is it enforced?
await client.query(
  "insert into conversations (identity_id, kind, partner_character, title) values ($1,'pm','Nyx','Nyx')",
  [ident.id],
);
try {
  await client.query(
    "insert into conversations (identity_id, kind, partner_character, title) values ($1,'pm','nyx','nyx')",
    [ident.id],
  );
  console.log("[db] partial+expression unique index NOT enforced (bad)");
} catch (e) {
  console.log(
    "[db] partial+expression unique index enforced:",
    (e.message ?? String(e)).slice(0, 120),
  );
}
// ...and its predicate still lets a second channel row (null partner) in.
await client.query(
  "insert into conversations (identity_id, kind, channel_key, title) values ($1,'channel','Other','Other')",
  [ident.id],
);
console.log(
  "[db] conversations:",
  (await client.query("select count(*)::int c from conversations")).rows[0].c,
);

await app.close();
await client.close();
console.log("[boot] closed cleanly");
