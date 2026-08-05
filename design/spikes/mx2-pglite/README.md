# MX2 spike code — pglite feasibility (#297)

Throwaway harnesses kept because #298 (the `createDb` driver seam) will want
to re-run them. **Not wired into the workspace**: no `package.json`, no turbo
task, excluded from `eslint .` via the `design/spikes/**` ignore in
`eslint.config.js`, and `design/` is already in `.prettierignore`.

The findings these produced are in **`design/mx2-pglite-spike.md`** — read that
first; this directory is only the how-to-reproduce.

## Running them

`@electric-sql/pglite` is deliberately **not** a workspace dependency. Install
it into a scratch directory and make it resolvable:

```sh
mkdir -p /tmp/mx2 && cd /tmp/mx2
npm init -y && npm pkg set type=module
npm install @electric-sql/pglite

# make it resolvable from apps/server and from drizzle-orm's pglite driver
cd <repo>
ln -s /tmp/mx2/node_modules/@electric-sql apps/server/node_modules/@electric-sql
ln -s /tmp/mx2/node_modules/@electric-sql \
  node_modules/.pnpm/drizzle-orm@*/node_modules/@electric-sql
```

| File | Where to run it | What it proves |
|---|---|---|
| `sql-features.mjs` | anywhere with pglite resolvable | `uuidv7()`, advisory locks, jsonb, lateral, FTS — and which extensions are missing |
| `boot.mjs` | copy into `apps/server/`, after `pnpm turbo run build --filter=@emberchat/server...` | the real `buildApp` boots on pglite; upgrade gate, all 22 migrations, REST, the raw `db.execute`, jsonb, partial+expression indexes |
| `bench.mjs` | copy into `apps/server/` | ~100k messages seeded, the history reads timed, pglite vs a `postgres:18-alpine` container |
| `backup.mjs` | anywhere with pglite resolvable | cold copy, hot copy, `dumpDataDir()` round trip, durability settings, SIGKILL recovery, the missing data-dir lock |

`bench.mjs` needs a Postgres to compare against for its `pg` mode:

```sh
docker run -d --rm --name mx2-bench -e POSTGRES_PASSWORD=bench \
  -p 55499:5432 postgres:18-alpine
node bench.mjs pg "postgres://postgres:bench@127.0.0.1:55499/postgres"
```

## The two integration-suite variants

Not kept as files — they are one `sed` away and would rot. To reproduce:
copy `apps/server/src/modules/gateway/gateway.test.ts` (or
`history/history.test.ts`) to `*.pglite-spike.test.ts` and swap the fixture:

```diff
-import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
-import { migrate } from "drizzle-orm/node-postgres/migrator";
+import { PGlite } from "@electric-sql/pglite";
+import { drizzle } from "drizzle-orm/pglite";
+import { migrate } from "drizzle-orm/pglite/migrator";
-import { createDb, type Db } from "../../db/index.js";
+import { schema, type Db } from "../../db/index.js";
...
-  container = await new PostgreSqlContainer("postgres:18-alpine").start();
-  ({ db, pool } = createDb(container.getConnectionUri()));
+  client = await PGlite.create();
+  db = drizzle(client, { schema, casing: "snake_case" });
   await migrate(db, { migrationsFolder: MIGRATIONS });
```

That is the whole diff, and it is exactly the seam #298 has to make first-class.
