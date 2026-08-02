import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema.js";

export function createDb(connectionString: string) {
  const pool = new pg.Pool({ connectionString });
  // Idle pooled clients surface backend failures as an out-of-band 'error'
  // event (pg docs) — a Postgres restart, or a testcontainer stopping while
  // a client lingers (CI run 30743606355: FATAL 57P01 failed an all-green
  // suite). Unhandled, that event kills the whole process; the pool itself
  // recovers by replacing the client, so log and move on.
  pool.on("error", (error) => {
    console.error("pg pool: idle client error", error);
  });
  const db = drizzle(pool, { schema, casing: "snake_case" });
  return { db, pool };
}

export type Db = ReturnType<typeof createDb>["db"];
export * as schema from "./schema.js";
