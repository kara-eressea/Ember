// Production static serving (M1 step 11): one Fastify serves both the API
// and the built web app.
//
// This used to rewrite index.html on the way in, injecting a
// `window.__CONFIG__` bootstrap (with a matching CSP script hash) and serving
// `/config.json` as its fallback — the whole of it existed to carry one string,
// the configured product name, into a build that was not allowed to contain it.
// The name is a build-time constant now (#556, decisions.md §5), so the
// document is served exactly as Vite emitted it and the served app carries no
// inline script at all.

import { readFile } from "node:fs/promises";
import path from "node:path";
import fastifyStatic from "@fastify/static";
import type { FastifyInstance, FastifyReply } from "fastify";

export interface WebStaticOptions {
  /** Absolute path to the built web app (apps/web/dist). */
  root: string;
}

export async function webStatic(
  instance: FastifyInstance,
  options: WebStaticOptions,
): Promise<void> {
  const indexHtml = await readFile(
    path.join(options.root, "index.html"),
    "utf8",
  );

  await instance.register(fastifyStatic, {
    root: options.root,
    index: false,
    setHeaders: (reply: FastifyReply, filePath: string) => {
      // Vite emits content-hashed filenames under assets/ — cache forever.
      if (filePath.includes(`${path.sep}assets${path.sep}`)) {
        void reply.header(
          "cache-control",
          "public, max-age=31536000, immutable",
        );
      }
      // The push service worker (design/web-push.md §4) is the one script
      // served under its own unhashed name, and it is also the one that
      // outlives the deployment that installed it: a cached copy keeps
      // running until its entry expires, on a file whose whole update path is
      // the browser re-requesting it. Never cached, same as the document.
      if (filePath.endsWith(`${path.sep}sw.js`)) {
        void reply.header("cache-control", "no-cache");
      }
    },
  });

  const sendIndex = (reply: FastifyReply) =>
    reply
      .header("cache-control", "no-cache")
      .type("text/html; charset=utf-8")
      .send(indexHtml);

  // `index: false` makes a bare `/` a directory request (403), so the root
  // is an explicit route rather than a static lookup.
  instance.get("/", (_request, reply) => sendIndex(reply));

  // SPA fallback: any unknown GET outside the API surface is a client route
  // (/login, /app/:identityId/…) and gets the injected index.html.
  instance.setNotFoundHandler((request, reply) => {
    const url = request.raw.url ?? "/";
    if (
      (request.method === "GET" || request.method === "HEAD") &&
      !url.startsWith("/api") &&
      !url.startsWith("/gateway")
    ) {
      return sendIndex(reply);
    }
    return reply.code(404).send({ error: "Not found" });
  });
}
