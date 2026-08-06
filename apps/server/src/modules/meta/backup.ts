// One-file backup of the embedded database (#548).
//
// WHY THIS IS AN HTTP ENDPOINT AND NOT A FUNCTION CALL. The desktop client's
// database is pglite, and pglite is a whole Postgres compiled to WASM living
// inside *this* process — the server child the Electron shell forked. The shell
// cannot call `dumpDataDir()` on it: nothing outside this process holds the
// instance, and pglite takes no data-directory lock, so a second process
// opening those files is corruption rather than a second reader (MX2 §Q4). The
// only thing the shell and the database share is this server's own loopback
// socket, so the backup travels the way everything else does — over it,
// authenticated the way everything else is.
//
// WHY THE DRIVER GATES IT. `dumpDataDir` is a pglite capability and the handle
// only carries it under that driver (db/index.ts). A Postgres deployment's
// backup story is its operator's, and it is `pg_dump` against a database this
// process is merely a client of — there is no directory here to tar. So the
// route exists on every instance (a 404 that explains itself beats a 404 that
// does not) and refuses on all but the embedded one.
//
// WHAT IT IS NOT: a restore. Reading a tarball back means replacing a data
// directory while nothing is looking at it, which is a different risk class
// from writing one out — the failure mode of a bad backup is a useless file,
// and the failure mode of a bad restore is the history it overwrote.
// docs/desktop.md documents the manual route instead.

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { APP_NAME } from "@emberchat/protocol";

/** Requests per minute. A dump walks the whole data directory and builds the
 * tarball in memory; repeating that in a loop is the one way to make it cost
 * something. Generous for a human clicking a menu item. */
export const BACKUP_RATE_LIMIT_MAX = 5;

export const BACKUP_CONTENT_TYPE = "application/gzip";

/**
 * What the downloaded file is called: the product, what it is, and the day it
 * was taken. Dated rather than timestamped — a backup is a thing you keep, and
 * a name you can read beats one that sorts to the second. Two on one day differ
 * by the browser's or the shell's own "(1)", which is the platform's job.
 */
export function backupFilename(now: Date): string {
  const day = now.toISOString().slice(0, 10);
  return `${APP_NAME.toLowerCase()}-backup-${day}.tar.gz`;
}

export interface BackupRoutesOptions {
  /**
   * The pglite handle's dump, or absent on any other driver — see the module
   * comment. Absent is the gate: the route answers 404 and says why.
   */
  readonly dumpDataDir?: () => Promise<Blob>;
}

// eslint-disable-next-line @typescript-eslint/require-await -- fastify async plugin signature
export async function backupRoutes(
  app: FastifyInstance,
  options: BackupRoutesOptions,
): Promise<void> {
  const dump = options.dumpDataDir;

  app.get(
    "/backup",
    {
      preHandler: app.authenticate,
      config: {
        rateLimit: { max: BACKUP_RATE_LIMIT_MAX, timeWindow: "1 minute" },
      },
      schema: {
        // No 200 response schema: the body is a tarball, not JSON.
        response: {
          401: z.object({ error: z.string() }),
          404: z.object({ error: z.string() }),
        },
      },
    },
    async (_request, reply) => {
      if (dump === undefined) {
        return reply.code(404).send({
          error:
            "This server keeps its data in a Postgres database it does not own, so there is nothing here to package up. Back it up with your own Postgres tools (pg_dump).",
        });
      }
      // Consistent as of now, taken while everything keeps running: that is
      // the whole point of the primitive, and why this needs no quiet moment
      // and no downtime (MX2 spike §4).
      const archive = await dump();
      // Buffered rather than streamed. `dumpDataDir` has already built the
      // whole tarball in memory before it resolves — there is no upstream to
      // stream *from*, so a stream here would add a copy and a failure mode
      // without saving a byte.
      const bytes = Buffer.from(await archive.arrayBuffer());
      return reply
        .header("content-type", BACKUP_CONTENT_TYPE)
        .header(
          "content-disposition",
          `attachment; filename="${backupFilename(new Date())}"`,
        )
        .send(bytes);
    },
  );
}
