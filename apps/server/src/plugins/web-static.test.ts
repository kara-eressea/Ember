// The production static mode: files served, SPA routes falling back to an
// index.html carrying the injected runtime config, API 404s staying JSON.

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { webStatic } from "./web-static.js";

let root: string;
let app: FastifyInstance;

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "emberchat-webdist-"));
  await writeFile(
    path.join(root, "index.html"),
    "<!doctype html><html><head><title>x</title></head><body></body></html>",
  );
  await mkdir(path.join(root, "assets"));
  await writeFile(
    path.join(root, "assets", "app-abc123.js"),
    "console.log(1);",
  );

  app = Fastify();
  await app.register(webStatic, { root, appName: "Testline </script>" });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await rm(root, { recursive: true, force: true });
});

describe("webStatic", () => {
  it("serves the SPA at / with the runtime config injected", async () => {
    const response = await app.inject({ method: "GET", url: "/" });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/html");
    expect(response.body).toContain('window.__CONFIG__={"appName":"Testline ');
    // The injected JSON must not be able to close the script tag.
    expect(response.body).not.toContain("</script></script>");
    expect(response.body).toContain("\\u003c/script>");
  });

  it("falls back to index.html for client routes", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/app/some-identity/some-conv",
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("window.__CONFIG__");
    expect(response.headers["cache-control"]).toBe("no-cache");
  });

  it("serves hashed assets immutably", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/assets/app-abc123.js",
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toContain("immutable");
  });

  it("keeps unknown API paths as JSON 404s", async () => {
    const response = await app.inject({ method: "GET", url: "/api/nope" });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "Not found" });

    const post = await app.inject({ method: "POST", url: "/whatever" });
    expect(post.statusCode).toBe(404);
  });

  it("serves /config.json as the fallback config source", async () => {
    const response = await app.inject({ method: "GET", url: "/config.json" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ appName: "Testline </script>" });
  });
});
