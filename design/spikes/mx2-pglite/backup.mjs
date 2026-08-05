// MX2 SPIKE CODE — not part of the build. See README.md in this directory.
//
// The pglite backup story, executed:
//   1. cold copy   — write, close(), cp -R, reopen the copy, read + write it
//   2. hot copy    — cp -R while the process holds the dir open
//   3. dumpDataDir — the tarball route, taken while running, then restored
//   4. settings    — what durability knobs pglite actually runs with
//   5. crash       — SIGKILL a child mid-life, reopen, check the committed row
//   6. no lock     — two PGlite instances on ONE data dir at the same time
//
//   node backup.mjs [workDir]     (default: ./.mx2-backup-scratch)

import { PGlite } from "@electric-sql/pglite";
import { cp, rm, mkdir, writeFile, stat } from "node:fs/promises";
import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.argv[3] ?? path.join(HERE, ".mx2-backup-scratch");
const LIVE = `${ROOT}/live`;

function du(dir) {
  return execFileSync("du", ["-sh", dir]).toString().trim().split("\t")[0];
}

// The crash half runs as a child of itself: commit a row, then SIGKILL.
if (process.argv[2] === "crash-child") {
  const db = await PGlite.create(LIVE);
  await db.query("insert into marker (note) values ('committed-then-SIGKILL')");
  console.log("[5] child committed a row; SIGKILL self");
  process.kill(process.pid, "SIGKILL");
}

await rm(ROOT, { recursive: true, force: true });
await mkdir(ROOT, { recursive: true });

// ---- 1. write, close, copy, reopen the copy -----------------------------
{
  const db = await PGlite.create(LIVE);
  await db.exec(
    "create table marker (id serial primary key, note text, at timestamptz default now())",
  );
  for (let i = 0; i < 5000; i++) {
    await db.query("insert into marker (note) values ($1)", [`row ${i}`]);
  }
  const c = await db.query("select count(*)::int c from marker");
  console.log("[1] live rows before close:", c.rows[0].c);
  await db.close();
  console.log("[1] closed. data dir size:", du(LIVE));
}
await cp(LIVE, `${ROOT}/cold-copy`, { recursive: true });
{
  const db = await PGlite.create(`${ROOT}/cold-copy`);
  const c = await db.query("select count(*)::int c from marker");
  console.log("[1] COLD COPY reopened, rows:", c.rows[0].c);
  await db.query("insert into marker (note) values ('written into the copy')");
  const c2 = await db.query("select count(*)::int c from marker");
  console.log("[1] COLD COPY writable, rows:", c2.rows[0].c);
  await db.close();
}

// ---- 2. copy WHILE the process holds it open ----------------------------
// NOTE: an in-process fs.cp barely interleaves — pglite's WASM work is
// synchronous and starves the event loop — so this is the friendly case.
// The hostile case (an EXTERNAL cp/rsync/Time Machine) is discussed in the
// findings document; it also opened cleanly, three times out of three, which
// is evidence and not a guarantee.
{
  const db = await PGlite.create(LIVE);
  await db.query("insert into marker (note) values ('hot-1')");
  await cp(LIVE, `${ROOT}/hot-copy`, { recursive: true });
  await db.query("insert into marker (note) values ('hot-2')");
  const live = await db.query("select count(*)::int c from marker");
  console.log("[2] live rows after the hot copy (+2 writes):", live.rows[0].c);
  await db.close();
  try {
    const copy = await PGlite.create(`${ROOT}/hot-copy`);
    const c = await copy.query("select count(*)::int c from marker");
    console.log("[2] HOT COPY opened, rows:", c.rows[0].c);
    await copy.close();
  } catch (e) {
    console.log("[2] HOT COPY FAILED TO OPEN:", e.message ?? String(e));
  }
}

// ---- 3. dumpDataDir() — the tarball route, taken while running ----------
{
  const db = await PGlite.create(LIVE);
  await db.query("insert into marker (note) values ('before dump')");
  const t = Date.now();
  const file = await db.dumpDataDir("gzip");
  const bytes = Buffer.from(await file.arrayBuffer());
  console.log(
    "[3] dumpDataDir(gzip) ms:",
    Date.now() - t,
    "bytes:",
    bytes.length,
    "name:",
    file.name ?? "(blob)",
  );
  await writeFile(`${ROOT}/dump.tgz`, bytes);
  await db.close();

  const restored = await PGlite.create(`${ROOT}/tar-restore`, {
    loadDataDir: new Blob([bytes]),
  });
  const c = await restored.query("select count(*)::int c from marker");
  console.log("[3] restored from tarball, rows:", c.rows[0].c);
  const last = await restored.query(
    "select note from marker order by id desc limit 1",
  );
  console.log("[3] restored newest row:", last.rows[0].note);
  await restored.close();
  console.log("[3] dump.tgz bytes on disk:", (await stat(`${ROOT}/dump.tgz`)).size);
}

// ---- 4. what durability knobs does pglite actually run with? ------------
{
  const db = await PGlite.create(LIVE);
  const s = await db.query(
    `select name, setting, source from pg_settings
     where name in ('fsync','full_page_writes','synchronous_commit','wal_level','data_checksums')
     order by name`,
  );
  for (const row of s.rows) {
    console.log(`[4] ${row.name} = ${row.setting} (source: ${row.source})`);
  }
  await db.exec("alter system set fsync = on");
  console.log("[4] ALTER SYSTEM SET fsync=on accepted — see [5] for whether it sticks");
  await db.close();
}
{
  const db = await PGlite.create(LIVE);
  const s = await db.query("select setting from pg_settings where name='fsync'");
  console.log("[4] fsync after reopen:", s.rows[0].setting);
  await db.close();
}

// ---- 5. crash: SIGKILL with no close() ----------------------------------
{
  const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "crash-child", ROOT], {
    stdio: "inherit",
  });
  console.log("[5] child signal:", r.signal);
  const db = await PGlite.create(LIVE);
  const c = await db.query(
    "select count(*)::int c from marker where note='committed-then-SIGKILL'",
  );
  console.log("[5] reopened after SIGKILL; committed row present:", c.rows[0].c);
  await db.close();
}

// ---- 6. is there a data-dir lock? ---------------------------------------
{
  const first = await PGlite.create(LIVE);
  try {
    const second = await PGlite.create(LIVE);
    const c = await second.query("select count(*)::int c from marker");
    console.log(
      "[6] SECOND OPENER SUCCEEDED on the same dataDir — NO LOCK. rows:",
      c.rows[0].c,
    );
    await second.close();
  } catch (e) {
    console.log("[6] second opener refused:", (e.message ?? String(e)).slice(0, 200));
  }
  await first.close();
}
