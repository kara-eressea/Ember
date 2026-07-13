// Production static serving (M1 step 11): one Fastify serves both the API
// and the built web app. Branding stays runtime config (decisions.md §5) —
// index.html gets `window.__CONFIG__` injected at boot so the client never
// needs a config fetch, and /config.json remains as the documented fallback.

import { readFile } from "node:fs/promises";
import path from "node:path";
import fastifyStatic from "@fastify/static";
import type { FastifyInstance, FastifyReply } from "fastify";

export interface WebStaticOptions {
  /** Absolute path to the built web app (apps/web/dist). */
  root: string;
  appName: string;
}

export async function webStatic(
  instance: FastifyInstance,
  options: WebStaticOptions,
): Promise<void> {
  const runtimeConfig = { appName: options.appName };
  // <-escape so a hostile APP_NAME can't close the script tag.
  const configJson = JSON.stringify(runtimeConfig).replaceAll("<", "\\u003c");
  const indexHtml = (
    await readFile(path.join(options.root, "index.html"), "utf8")
  ).replace(
    "</head>",
    `<script>window.__CONFIG__=${configJson}</script></head>`,
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

  instance.get("/config.json", () => runtimeConfig);

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
