// MX2 SPIKE CODE — not part of the build. See README.md in this directory.
//
// Every Postgres-ism the server's SQL depends on, asked of pglite directly.
//   node sql-features.mjs

import { PGlite } from "@electric-sql/pglite";
const db = await PGlite.create();
const checks = [
  ["uuidv7()", "select uuidv7()"],
  ["uuid_extract_timestamp", "select uuid_extract_timestamp(uuidv7())"],
  ["gen_random_uuid()", "select gen_random_uuid()"],
  ["hashtext()", "select hashtext('abc')"],
  ["pg_advisory_xact_lock", "begin; select pg_advisory_xact_lock(hashtext('x')); commit"],
  ["greatest/least", "select greatest(1,2), least(1,2)"],
  ["ilike + escape", "select 'AbC' ilike '%b\\_c%' escape '\\'"],
  ["jsonb ops", "select ('{\"a\":1}'::jsonb || '{\"b\":2}'::jsonb) ->> 'b'"],
  ["jsonb_set", "select jsonb_set('{\"a\":1}'::jsonb, '{a}', '2'::jsonb)"],
  ["generate_series", "select count(*) from generate_series(1,10)"],
  ["now()/interval", "select now() - interval '1 day'"],
  ["on conflict do update", "create temp table t(a int primary key, b int); insert into t values (1,1) on conflict (a) do update set b = excluded.b"],
  ["cte + lateral", "select * from (select 1 x) s, lateral (select s.x y) l"],
  ["window fn", "select row_number() over (order by g) from generate_series(1,3) g"],
  ["listen/notify", "listen chan"],
  ["pg_size_pretty", "select pg_size_pretty(pg_database_size(current_database()))"],
  ["to_tsvector (FTS)", "select to_tsvector('english','hello world')"],
  ["citext ext", "create extension if not exists citext"],
  ["pg_trgm ext", "create extension if not exists pg_trgm"],
];
for (const [name, sql] of checks) {
  try {
    await db.exec(sql);
    console.log("OK   ", name);
  } catch (e) {
    console.log("FAIL ", name, "->", (e.message ?? String(e)).slice(0, 110));
  }
}
await db.close();
