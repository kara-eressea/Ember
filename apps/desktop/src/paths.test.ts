import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertArtifactsPresent,
  MissingArtifactError,
  resolveArtifactPaths,
  type DesktopArtifacts,
} from "./paths.js";

/**
 * The packaged layout is the half of this that no test on a checkout could
 * otherwise reach — which is exactly why the resolution is a pure function over
 * `app.isPackaged`, `process.resourcesPath` and two roots rather than a set of
 * `if (app.isPackaged)` branches scattered through the shell.
 *
 * Expected paths are built with `join` rather than written as literals, so the
 * suite means the same thing on Windows (where these run in CI's packaging
 * legs) as it does on macOS.
 */

const CHECKOUT = {
  packaged: false,
  desktopRoot: resolve("/repo/apps/desktop"),
  // Electron sets this to something in a checkout too; nothing may read it.
  resourcesPath: resolve("/nowhere/Resources"),
  platform: "darwin" as NodeJS.Platform,
};

const PACKAGED = {
  packaged: true,
  desktopRoot: resolve(
    "/Applications/EmberChat.app/Contents/Resources/app.asar",
  ),
  resourcesPath: resolve("/Applications/EmberChat.app/Contents/Resources"),
  platform: "darwin" as NodeJS.Platform,
};

describe("the checkout layout", () => {
  const artifacts = resolveArtifactPaths(CHECKOUT);

  it("finds the server runtime where build-server-runtime.mjs leaves it", () => {
    // `pnpm deploy` roots the package at the target, so the entry is the
    // tree's own dist/ and not a repo-shaped apps/server/dist.
    expect(artifacts.serverEntry).toBe(
      join(CHECKOUT.desktopRoot, "server-runtime", "dist", "main.js"),
    );
    expect(artifacts.adminCli).toBe(
      join(CHECKOUT.desktopRoot, "server-runtime", "dist", "cli", "admin.js"),
    );
  });

  it("finds the static pages beside src/, not in dist/", () => {
    expect(artifacts.chooserPage).toBe(
      join(CHECKOUT.desktopRoot, "chooser", "index.html"),
    );
    expect(artifacts.errorPage).toBe(
      join(CHECKOUT.desktopRoot, "error", "index.html"),
    );
  });

  it("reaches one package over for the web dist", () => {
    expect(artifacts.webDist).toBe(resolve("/repo/apps/web/dist"));
  });
});

describe("the packaged layout", () => {
  const artifacts = resolveArtifactPaths(PACKAGED);

  it("puts every artifact under resourcesPath, and nothing beside the asar", () => {
    for (const path of [
      artifacts.serverEntry,
      artifacts.adminCli,
      artifacts.chooserPage,
      artifacts.errorPage,
      artifacts.trayIcon,
      artifacts.webDist,
    ]) {
      expect(path.startsWith(PACKAGED.resourcesPath)).toBe(true);
      // The asar holds the main-process JS and nothing this file resolves:
      // native modules cannot be loaded out of an archive, and the web dist is
      // served by a child process from a real directory.
      expect(path.includes("app.asar")).toBe(false);
    }
  });

  it("keeps the same names electron-builder's extraResources copies in as", () => {
    expect(artifacts.serverEntry).toBe(
      join(PACKAGED.resourcesPath, "server-runtime", "dist", "main.js"),
    );
    expect(artifacts.chooserPage).toBe(
      join(PACKAGED.resourcesPath, "chooser", "index.html"),
    );
    expect(artifacts.errorPage).toBe(
      join(PACKAGED.resourcesPath, "error", "index.html"),
    );
    // `dist` is renamed on the way in — the resources layer is a list of
    // things, not a list of dists.
    expect(artifacts.webDist).toBe(join(PACKAGED.resourcesPath, "web"));
  });
});

describe("the tray icon", () => {
  it("is a template image on macOS and the app's own artwork elsewhere", () => {
    const icon = (platform: NodeJS.Platform, packaged: boolean) =>
      resolveArtifactPaths({
        ...(packaged ? PACKAGED : CHECKOUT),
        platform,
      }).trayIcon;
    const root = CHECKOUT.desktopRoot;
    expect(icon("darwin", false)).toBe(
      join(root, "assets", "trayTemplate.png"),
    );
    expect(icon("win32", false)).toBe(join(root, "assets", "tray.png"));
    // Not a target for this release; it gets the drawn artwork, which is the
    // right answer for the tray areas Linux does have.
    expect(icon("linux", false)).toBe(join(root, "assets", "tray.png"));
    expect(icon("win32", true)).toBe(
      join(PACKAGED.resourcesPath, "assets", "tray.png"),
    );
  });
});

describe("the missing-artifact message", () => {
  /** A resources layer with only the pieces named, so each branch can fire. */
  function layout(present: {
    server?: boolean;
    web?: boolean;
  }): DesktopArtifacts {
    // A whole miniature `apps/` per call, because the checkout layout reaches
    // one directory up for the web dist — a flat sandbox would let one case's
    // `apps/web/dist` satisfy the next case's lookup.
    const apps = mkdtempSync(join(tmpdir(), "ember-paths-"));
    const artifacts = resolveArtifactPaths({
      packaged: false,
      desktopRoot: join(apps, "desktop"),
      resourcesPath: join(apps, "desktop"),
      platform: "darwin",
    });
    if (present.server === true) {
      for (const path of [artifacts.serverEntry, artifacts.adminCli]) {
        mkdirSync(join(path, ".."), { recursive: true });
        writeFileSync(path, "");
      }
    }
    if (present.web === true) {
      mkdirSync(artifacts.webDist, { recursive: true });
      writeFileSync(join(artifacts.webDist, "index.html"), "");
    }
    return artifacts;
  }

  it("passes when both artifacts are there", () => {
    expect(() => {
      assertArtifactsPresent(layout({ server: true, web: true }));
    }).not.toThrow();
  });

  it("names the command that builds the server runtime", () => {
    expect(() => {
      assertArtifactsPresent(layout({ web: true }));
    }).toThrow(/server-runtime/);
  });

  it("names the command that builds the web app, once the server is there", () => {
    expect(() => {
      assertArtifactsPresent(layout({ server: true }));
    }).toThrow(/@emberchat\/web build/);
  });

  it("tells a packaged app's user to reinstall, not to run pnpm", () => {
    // The two layouts are missing different things: a checkout is missing a
    // build step somebody can run, an install is missing part of itself.
    const artifacts = { ...layout({}), packaged: true };
    let message = "";
    try {
      assertArtifactsPresent(artifacts);
    } catch (error) {
      expect(error).toBeInstanceOf(MissingArtifactError);
      message = error instanceof Error ? error.message : "";
    }
    expect(message).toContain("Reinstalling");
    expect(message).not.toContain("pnpm");
  });
});
