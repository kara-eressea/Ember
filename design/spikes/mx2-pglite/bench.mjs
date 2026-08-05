// MX2 SPIKE CODE — not part of the build. See README.md in this directory.
//
// Seeds ~100k messages and times the reads that matter, on either driver.
// Identical SQL text both sides. Copy to apps/server/ and run from there:
//   node bench.mjs pglite <dataDir>
//   node bench.mjs pg <connectionString>
import { PGlite } from "@electric-sql/pglite";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { migrate as migratePglite } from "drizzle-orm/pglite/migrator";
import { drizzle as drizzlePg } from "drizzle-orm/node-postgres";
import { migrate as migratePg } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { fileURLToPath } from "node:url";

const MIGRATIONS = fileURLToPath(new URL("./drizzle", import.meta.url));
const [driver, target] = process.argv.slice(2);
const N = Number(process.env.N ?? 100_000);

function ms(t) {
  return `${(Date.now() - t).toString()}ms`;
}

let query, close, label;
const tBoot = Date.now();
if (driver === "pglite") {
  const client = await PGlite.create(target ? { dataDir: target } : {});
  query = (sql, params) => client.query(sql, params);
  close = () => client.close();
  label = "pglite";
  console.log(`[${label}] connect ${ms(tBoot)}`);
  const t = Date.now();
  await migratePglite(drizzlePglite(client), { migrationsFolder: MIGRATIONS });
  console.log(`[${label}] migrate ${ms(t)}`);
} else {
  const pool = new pg.Pool({ connectionString: target });
  query = (sql, params) => pool.query(sql, params);
  close = () => pool.end();
  label = "node-postgres";
  console.log(`[${label}] connect ${ms(tBoot)}`);
  const t = Date.now();
  await migratePg(drizzlePg(pool), { migrationsFolder: MIGRATIONS });
  console.log(`[${label}] migrate ${ms(t)}`);
}

// --- fixture -------------------------------------------------------------
await query(
  "insert into app_users (email, username, password_hash) values ('b@e.test','b','x') on conflict do nothing",
);
const [user] = (await query("select id from app_users limit 1")).rows;
await query(
  "insert into flist_accounts (user_id, account_name) values ($1,'acct') on conflict do nothing",
  [user.id],
);
const [acct] = (await query("select id from flist_accounts limit 1")).rows;
await query(
  "insert into identities (flist_account_id, character_name) values ($1,'Amber Vale') on conflict do nothing",
  [acct.id],
);
const [ident] = (await query("select id from identities limit 1")).rows;
for (let c = 0; c < 20; c++) {
  await query(
    "insert into conversations (identity_id, kind, channel_key, title) values ($1,'channel',$2,$2) on conflict do nothing",
    [ident.id, `chan-${c.toString()}`],
  );
}
const convs = (await query("select id from conversations order by id")).rows;

// Per-row inserts — the history sink's real shape.
const SAMPLE = 2000;
const tIns = Date.now();
for (let i = 0; i < SAMPLE; i++) {
  await query(
    "insert into messages (conversation_id, sender_character, kind, bbcode, mention) values ($1,$2,'msg',$3,$4)",
    [
      convs[i % convs.length].id,
      `Char ${(i % 40).toString()}`,
      `single-row insert number ${i.toString()} with some [b]bbcode[/b] body text`,
      i % 97 === 0,
    ],
  );
}
const perRowMs = Date.now() - tIns;
console.log(
  `[${label}] ${SAMPLE.toString()} single-row inserts ${perRowMs.toString()}ms = ${(SAMPLE / (perRowMs / 1000)).toFixed(0)} rows/s`,
);

// Bulk to ~N.
const remaining = N - SAMPLE;
const tBulk = Date.now();
await query(
  `insert into messages (conversation_id, sender_character, kind, bbcode, created_at, mention)
   select c.id,
          'Char ' || (g % 40),
          'msg',
          'seeded message ' || g || ' lorem ipsum dolor sit amet needle' ||
            case when g % 5000 = 0 then ' HAYSTACK-TOKEN' else '' end,
          now() - (g || ' seconds')::interval,
          g % 97 = 0
   from generate_series(1, $1) g
   join lateral (select id from conversations offset (g % 20) limit 1) c on true`,
  [remaining],
);
console.log(`[${label}] bulk insert ${remaining.toString()} rows ${ms(tBulk)}`);
await query("analyze");
const total = (await query("select count(*)::int c from messages")).rows[0].c;
console.log(`[${label}] messages total ${total.toString()}`);

// --- reads ---------------------------------------------------------------
async function bench(name, sql, params, reps = 20) {
  await query(sql, params); // warm
  const t = Date.now();
  let rows = 0;
  for (let i = 0; i < reps; i++) {
    rows = (await query(sql, params)).rows.length;
  }
  const per = (Date.now() - t) / reps;
  console.log(
    `[${label}] ${name}: ${per.toFixed(2)}ms/query (${rows.toString()} rows, ${reps.toString()} reps)`,
  );
}

const conv = convs[0].id;
await bench(
  "conversation list",
  "select id, kind, channel_key, title, pinned, joined, last_read_message_id from conversations where identity_id=$1 order by created_at",
  [ident.id],
);
await bench(
  "backfill newest 50",
  "select id, sender_character, kind, bbcode, mention, created_at from messages where conversation_id=$1 order by id desc limit 50",
  [conv],
);
await bench(
  "page older (cursor)",
  "select id, bbcode from messages where conversation_id=$1 and id < $2 order by id desc limit 50",
  [conv, Math.floor(N / 2)],
);
await bench(
  "unread count",
  "select count(*)::int from messages where conversation_id=$1 and id > $2",
  [conv, Math.floor(N / 2)],
);
await bench(
  "mention count (identity-wide)",
  `select count(*)::int from messages m join conversations c on c.id = m.conversation_id
   where c.identity_id = $1 and m.mention`,
  [ident.id],
  5,
);
await bench(
  "ILIKE search (identity-wide, newest 50)",
  `select m.id, m.bbcode from messages m join conversations c on c.id = m.conversation_id
   where c.identity_id = $1 and m.bbcode ilike $2 order by m.id desc limit 50`,
  [ident.id, "%HAYSTACK-TOKEN%"],
  5,
);
await bench(
  "ILIKE search + from: filter",
  `select m.id from messages m join conversations c on c.id = m.conversation_id
   where c.identity_id = $1 and lower(m.sender_character) = lower($2)
     and m.bbcode ilike $3 order by m.id desc limit 50`,
  [ident.id, "Char 7", "%needle%"],
  5,
);

const size = await query(
  "select pg_size_pretty(pg_database_size(current_database())) s",
);
console.log(`[${label}] database size: ${size.rows[0].s}`);
await close();
