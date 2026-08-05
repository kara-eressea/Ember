// Production static serving (M1 step 11): one Fastify serves both the API
// and the built web app. Branding stays runtime config (decisions.md §5) —
// index.html gets `window.__CONFIG__` injected at boot so the client never
// needs a config fetch, and /config.json remains as the documented fallback.

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import fastifyStatic from "@fastify/static";
import type { FastifyInstance, FastifyReply } from "fastify";

export interface WebStaticOptions {
  /** Absolute path to the built web app (apps/web/dist). */
  root: string;
  appName: string;
}

/**
 * The `window.__CONFIG__` bootstrap injected into index.html, plus the CSP
 * source that permits it.
 *
 * The script must be inline — it exists precisely so boot doesn't wait on a
 * `/config.json` round-trip — and `script-src 'self'` blocks inline scripts, so
 * the policy has to name its hash. Hash rather than nonce: the document is
 * rendered once at boot and served byte-identical to everyone. Deriving both
 * halves here is what keeps them paired: change the script and the hash follows
 * (`web-static.test.ts` re-derives it from the served document as a guard).
 */
export function runtimeConfigScript(appName: string): {
  js: string;
  cspSource: string;
} {
  // <-escape so a hostile APP_NAME can't close the script tag.
  const json = JSON.stringify({ appName }).replaceAll("<", "\\u003c");
  const js = `window.__CONFIG__=${json}`;
  const digest = createHash("sha256").update(js, "utf8").digest("base64");
  return { js, cspSource: `'sha256-${digest}'` };
}

export async function webStatic(
  instance: FastifyInstance,
  options: WebStaticOptions,
): Promise<void> {
  const runtimeConfig = { appName: options.appName };
  const indexHtml = (
    await readFile(path.join(options.root, "index.html"), "utf8")
  ).replace(
    "</head>",
    `<script>${runtimeConfigScript(options.appName).js}</script></head>`,
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
