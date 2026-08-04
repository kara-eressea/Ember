// The install manifest (MP3 §1, #377): served from config, coloured from the
// web app's default theme, and pointing at icons that exist.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  MANIFEST_BACKGROUND_COLOR,
  MANIFEST_THEME_COLOR,
  webManifest,
  webManifestRoute,
} from "./web-manifest.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(here, "../../../web");

/** A product name no self-host would pick, so a literal in the route shows up
 * as a failure rather than as a coincidence. */
const APP_NAME = "Firestarter Testline";

const app = Fastify();

beforeAll(async () => {
  webManifestRoute(app, { appName: APP_NAME });
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

describe("GET /manifest.webmanifest", () => {
  it("names the app from config, as the manifest media type", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/manifest.webmanifest",
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain(
      "application/manifest+json",
    );
    // It carries configuration; a cached copy would outlive a rename.
    expect(response.headers["cache-control"]).toBe("no-cache");

    const manifest = response.json<ReturnType<typeof webManifest>>();
    expect(manifest.name).toBe(APP_NAME);
    expect(manifest.short_name).toBe(APP_NAME);
    // The whole document, product name included, must contain no trace of the
    // working title (CLAUDE.md): the name is a config token everywhere.
    expect(JSON.stringify(manifest)).not.toMatch(/ember/i);
  });

  it("is installable: scope, start_url, standalone, and both icon purposes", () => {
    const manifest = webManifest(APP_NAME);
    expect(manifest.start_url).toBe("/");
    expect(manifest.scope).toBe("/");
    expect(manifest.id).toBe("/");
    expect(manifest.display).toBe("standalone");
    // Chromium's installability bar: at least one icon ≥192 and one ≥512.
    const sizes = manifest.icons.map((icon) => icon.sizes);
    expect(sizes).toContain("192x192");
    expect(sizes).toContain("512x512");
    expect(manifest.icons.some((icon) => "purpose" in icon)).toBe(true);
  });

  it("offers route-based shortcuts that name no character and no instance", () => {
    const manifest = webManifest(APP_NAME);
    expect(manifest.shortcuts.map((shortcut) => shortcut.url)).toEqual([
      // The identity-agnostic alias and the picker: the only two routes that
      // mean the same thing to every user of an instance on every launch.
      "/app/@me",
      "/identities",
    ]);
    for (const shortcut of manifest.shortcuts) {
      expect(shortcut.name.length).toBeGreaterThan(0);
      expect(shortcut.short_name.length).toBeGreaterThan(0);
      // Baked once per instance, so a label may not carry the product name —
      // configured or working-title. Both would be wrong in a self-host.
      expect(shortcut.name).not.toContain(APP_NAME);
      expect(shortcut.short_name).not.toContain(APP_NAME);
      expect(`${shortcut.name} ${shortcut.short_name}`).not.toMatch(/ember/i);
      // A shortcut with no icon falls back to the app icon, which makes the
      // menu a list of identical rows.
      expect(shortcut.icons.length).toBeGreaterThan(0);
      // Relative to the scope, so a shortcut cannot navigate off the app.
      expect(shortcut.url.startsWith("/")).toBe(true);
    }
  });

  it("shortcuts point at routes the client router declares", () => {
    // A rotted shortcut is invisible until someone long-presses an installed
    // icon and lands on the catch-all redirect, so the URLs are checked
    // against the router itself. Read as text for the reason the colour guard
    // below gives: the server does not depend on the web app.
    const router = readFileSync(path.join(webRoot, "src/router.tsx"), "utf8");
    const declared = [...router.matchAll(/path="([^"]+)"/g)]
      .map(([, pattern]) => pattern ?? "")
      // The catch-all is the redirect a rotted shortcut would land on — it
      // matches everything, so counting it would make this test vacuous.
      .filter((pattern) => pattern !== "*")
      // React Router's `:param` matches one non-empty path segment.
      .map((pattern) => new RegExp(`^${pattern.replace(/:[^/]+/g, "[^/]+")}$`));
    for (const shortcut of webManifest(APP_NAME).shortcuts) {
      expect(
        declared.some((route) => route.test(shortcut.url)),
        shortcut.url,
      ).toBe(true);
    }
  });

  it("points at icons that exist, at the sizes it claims", () => {
    const manifest = webManifest(APP_NAME);
    const icons = [
      ...manifest.icons,
      ...manifest.shortcuts.flatMap((shortcut) => shortcut.icons),
    ];
    for (const icon of icons) {
      const file = path.join(webRoot, "public", icon.src);
      const png = readFileSync(file);
      // PNG IHDR: 8-byte signature, 4-byte length, "IHDR", then width and
      // height as big-endian uint32s. Cheaper than a decoder for the one
      // thing that has to be true.
      expect(png.subarray(12, 16).toString("ascii")).toBe("IHDR");
      const dimensions = `${String(png.readUInt32BE(16))}x${String(
        png.readUInt32BE(20),
      )}`;
      expect(dimensions).toBe(icon.sizes);
    }
  });
});

describe("manifest colours", () => {
  // The server cannot import the web app's tokens (it does not depend on it),
  // and a manifest is served long before any client module exists to be
  // asked — so the two hexes are duplicated in web-manifest.ts and their
  // agreement is asserted here instead. Same shape as base.test.ts, which
  // checks the numbers base.css cannot import.
  const tokens = readFileSync(
    path.join(webRoot, "src/theme/tokens.ts"),
    "utf8",
  );
  // NEUTRALS is the default base theme (`slate`), and the block runs from the
  // declaration to its closing brace.
  const neutrals = /export const NEUTRALS = \{([\s\S]*?)\n\} as const;/.exec(
    tokens,
  )?.[1];

  function token(name: string): string | undefined {
    return new RegExp(`\\n  ${name}: "(#[0-9a-f]{6})"`).exec(
      neutrals ?? "",
    )?.[1];
  }

  it("are the default theme's head and bg", () => {
    expect(token("head")).toBe(MANIFEST_THEME_COLOR);
    expect(token("bg")).toBe(MANIFEST_BACKGROUND_COLOR);
  });
});
