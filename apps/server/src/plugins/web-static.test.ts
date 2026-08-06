// The production static mode: files served, SPA routes falling back to
// index.html, API 404s staying JSON.

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { webStatic } from "./web-static.js";

const INDEX_HTML =
  "<!doctype html><html><head><title>x</title></head><body></body></html>";

let root: string;
let app: FastifyInstance;

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "emberchat-webdist-"));
  await writeFile(path.join(root, "index.html"), INDEX_HTML);
  await mkdir(path.join(root, "assets"));
  await writeFile(
    path.join(root, "assets", "app-abc123.js"),
    "console.log(1);",
  );
  // Vite copies public/ to the dist root, so the push worker lands here.
  await writeFile(path.join(root, "sw.js"), "self.addEventListener;");

  app = Fastify();
  await app.register(webStatic, { root });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await rm(root, { recursive: true, force: true });
});

describe("webStatic", () => {
  // Byte-identical to what Vite emitted: the document is no longer rewritten
  // on the way out, and the app it boots carries no inline script (#556).
  it("serves the SPA at / exactly as built", async () => {
    const response = await app.inject({ method: "GET", url: "/" });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/html");
    expect(response.body).toBe(INDEX_HTML);
  });

  it("falls back to index.html for client routes", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/app/some-identity/some-conv",
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe(INDEX_HTML);
    expect(response.headers["cache-control"]).toBe("no-cache");
  });

  // The pair of headers is the whole of MP3's no-service-worker mitigation
  // (#377): content-hashed bundles cached for a year give an installed app
  // warm cold-starts out of the plain HTTP cache, and the document that names
  // them must never be cached or a deploy would be invisible until the entry
  // expired. Pinned exactly rather than loosely — "contains immutable" would
  // pass a max-age of a minute, and a no-cache that drifted to max-age=0 would
  // still revalidate but stop being the documented contract.
  it("serves hashed assets immutably and the document not at all", async () => {
    const asset = await app.inject({
      method: "GET",
      url: "/assets/app-abc123.js",
    });
    expect(asset.statusCode).toBe(200);
    expect(asset.headers["cache-control"]).toBe(
      "public, max-age=31536000, immutable",
    );

    const index = await app.inject({ method: "GET", url: "/" });
    expect(index.statusCode).toBe(200);
    expect(index.headers["cache-control"]).toBe("no-cache");
  });

  // A root-scope service worker is the one file a stale cache can pin past a
  // deploy: it keeps running from disk until its entry expires, and the only
  // update path it has is the browser re-requesting the script. It is served
  // out of the same static root as the hashed bundles above and carries no
  // hash of its own, so the exemption has to be explicit (web-push.md §4).
  it("never caches the push service worker", async () => {
    const worker = await app.inject({ method: "GET", url: "/sw.js" });
    expect(worker.statusCode).toBe(200);
    expect(worker.headers["cache-control"]).toBe("no-cache");
  });

  it("keeps unknown API paths as JSON 404s", async () => {
    const response = await app.inject({ method: "GET", url: "/api/nope" });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "Not found" });

    const post = await app.inject({ method: "POST", url: "/whatever" });
    expect(post.statusCode).toBe(404);
  });

  // The runtime-branding endpoint is gone with the knob it served (#556); a
  // request for it is an ordinary client route, not a config source.
  it("has no /config.json endpoint left", async () => {
    const response = await app.inject({ method: "GET", url: "/config.json" });
    expect(response.headers["content-type"]).toContain("text/html");
  });
});
