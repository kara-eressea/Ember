/**
 * EmberChat desktop — Electron main process (MX3 #299, design/mx3-desktop-shell.md).
 *
 * What this process is: a window, a lifecycle, and a bouncer running beside
 * it. The embedded server (the same `apps/server` code a self-hoster deploys)
 * runs as a `utilityProcess` on 127.0.0.1 with pglite as its database, and the
 * window simply loads that origin. There is no renderer bundle here and never
 * will be — the renderer *is* the web app, byte for byte.
 *
 * Running it from a checkout:
 *
 *   pnpm --filter @emberchat/web build          # the renderer, once
 *   pnpm --filter @emberchat/desktop dev        # tsc + server-runtime + electron .
 *
 * `dev` calls `scripts/build-server-runtime.mjs`, which deploys the server
 * into `apps/desktop/server-runtime/` and rebuilds *that tree's* native
 * modules for Electron's ABI. The workspace's own `node_modules` is never
 * rebuilt (spec invariant 1) — a rebuilt tree cannot run the Node test suite,
 * and that is a one-way trip (design/mx2-pglite-spike.md §Q3).
 *
 * Not here yet: provisioning and auto-login (#301 — until then the window
 * lands on the app's login screen with an account that does not exist), the
 * mode chooser (#300), thin-client mode (#302), the tray (#304), packaging
 * (MX4). Local mode is hardcoded.
 */

import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, dialog } from "electron";
import {
  EmbeddedServerStartError,
  startEmbeddedServer,
  type EmbeddedServer,
} from "./embedded-server.js";
import { MissingArtifactError, resolveArtifacts } from "./paths.js";
import { createMainWindow } from "./window.js";

/** `apps/desktop` — this file lives in its `dist/`. */
const DESKTOP_ROOT = fileURLToPath(new URL("..", import.meta.url));

let server: EmbeddedServer | undefined;
let mainWindow: BrowserWindow | undefined;
let stopping = false;

// FIRST, before anything reads or writes the user data directory: pglite
// takes no lock of its own, so two instances on one data directory is
// corruption, not inconvenience (spec invariant 5, MX2 §Q4).
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow === undefined) {
      return;
    }
    if (mainWindow.isMinimized()) {
      mainWindow.restore();
    }
    mainWindow.focus();
  });
  void boot();
}

async function boot(): Promise<void> {
  await app.whenReady();
  try {
    const { entry, webDist } = resolveArtifacts(DESKTOP_ROOT);
    const dataDir = join(app.getPath("userData"), "db");
    mkdirSync(dataDir, { recursive: true });

    server = await startEmbeddedServer({
      entry,
      dataDir,
      webDist,
      // Throwaway: every boot invalidates the previous boot's sessions, which
      // is harmless while there is no account to log into. #301 generates a
      // real one and keeps it under safeStorage.
      authSecret: randomBytes(32).toString("base64url"),
      clientVersion: app.getVersion(),
    });
    server.onUnexpectedExit((code) => {
      if (stopping) {
        return;
      }
      fail(
        "The bouncer stopped",
        `The embedded server exited unexpectedly (code ${String(code)}).`,
      );
    });

    mainWindow = createMainWindow(server.origin);
    mainWindow.on("closed", () => {
      mainWindow = undefined;
    });
  } catch (error) {
    fail("EmberChat could not start", describeStartupError(error));
  }
}

// The bouncer is this app's whole point, so its child must not outlive it —
// SIGTERM lets apps/server close Fastify and the database properly.
app.on("will-quit", (event) => {
  if (server === undefined || stopping) {
    return;
  }
  event.preventDefault();
  stopping = true;
  void server.stop().finally(() => {
    server = undefined;
    app.quit();
  });
});

// #304 turns this into close-to-tray: in local mode the bouncer keeps running
// after the last window closes — that is the product. Until the tray exists,
// closing the window with no way to get it back has to mean quitting.
app.on("window-all-closed", () => {
  app.quit();
});

app.on("activate", () => {
  if (mainWindow === undefined && server !== undefined && !stopping) {
    mainWindow = createMainWindow(server.origin);
    mainWindow.on("closed", () => {
      mainWindow = undefined;
    });
  }
});

/** A blank window explains nothing; a dialog with the child's own words does. */
function fail(title: string, detail: string): void {
  dialog.showErrorBox(title, detail);
  stopping = true;
  void (server?.stop() ?? Promise.resolve()).finally(() => {
    app.exit(1);
  });
}

function describeStartupError(error: unknown): string {
  if (error instanceof MissingArtifactError) {
    return error.message;
  }
  if (error instanceof EmbeddedServerStartError) {
    return error.childStderr === ""
      ? error.message
      : `${error.message}\n\n${error.childStderr}`;
  }
  return error instanceof Error
    ? (error.stack ?? error.message)
    : String(error);
}
