import { migrate } from "drizzle-orm/node-postgres/migrator";
import { fileURLToPath } from "node:url";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createDb } from "./db/index.js";

const config = loadConfig();
const { db, pool } = createDb(config.DATABASE_URL);

await migrate(db, {
  migrationsFolder: fileURLToPath(new URL("../drizzle", import.meta.url)),
});

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
