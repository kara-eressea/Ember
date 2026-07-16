import { migrate } from "drizzle-orm/node-postgres/migrator";
import { fileURLToPath } from "node:url";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createDb } from "./db/index.js";
import {
  assertUpgradeSafe,
  loadUpgradeManifest,
  UpgradeRefusedError,
} from "./db/upgrade-gate.js";

const config = loadConfig();
const { db, pool } = createDb(config.DATABASE_URL);

const migrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));
try {
  await assertUpgradeSafe({
    pool,
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
await migrate(db, { migrationsFolder });

const app = await buildApp({ config, db });

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void app
      .close()
      .then(() => pool.end())
      .finally(() => process.exit(0));
  });
}

await app.listen({ host: config.HOST, port: config.PORT });
