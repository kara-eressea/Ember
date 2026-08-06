import { fileURLToPath } from "node:url";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createDb, dbDriverFrom } from "./db/index.js";
import {
  assertUpgradeSafe,
  loadUpgradeManifest,
  UpgradeRefusedError,
} from "./db/upgrade-gate.js";

const config = loadConfig();
// `dumpDataDir` is the embedded database's alone (#548) — undefined on
// node-postgres, which is what makes GET /api/backup refuse there.
const { db, raw, migrate, close, dumpDataDir } = await createDb(
  dbDriverFrom(config),
);

const migrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));
try {
  await assertUpgradeSafe({
    pool: raw,
    manifest: await loadUpgradeManifest(migrationsFolder),
    confirmBreaking: config.CONFIRM_BREAKING_UPGRADE,
    releasesUrl: `https://github.com/${config.UPDATE_CHECK_REPO}/releases`,
  });
} catch (error) {
  if (error instanceof UpgradeRefusedError) {
    console.error(`\n${error.message}\n`);
    process.exit(1);
  }
  throw error;
}
await migrate(migrationsFolder);

const app = await buildApp({
  config,
  db,
  ...(dumpDataDir !== undefined ? { dumpDataDir } : {}),
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void app
      .close()
      .then(() => close())
      .finally(() => process.exit(0));
  });
}

await app.listen({ host: config.HOST, port: config.PORT });
