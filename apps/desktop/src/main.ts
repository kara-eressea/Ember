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
 * #301 added the rest of what makes local mode usable: first-run provisioning
 * (an app account created through the runtime's admin CLI), both secrets under
 * `safeStorage`, and a main-process login whose session is seeded into the
 * renderer's localStorage by the preload — so the window opens signed in.
 *
 * Not here yet: the mode chooser (#300), thin-client mode (#302), the tray
 * (#304), packaging (MX4). Local mode is hardcoded.
 */

import { hostname } from "node:os";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, dialog, ipcMain, safeStorage } from "electron";
import { AdminCliError, provisionAppAccount } from "./admin-cli.js";
import { appAccount, deviceLabel } from "./app-account.js";
import {
  authSeedMessage,
  createSeedDispenser,
  AUTH_SEED_CHANNEL,
  type SeedDispenser,
} from "./auth-seed.js";
import { DesktopLoginError, loginAppAccount } from "./desktop-login.js";
import {
  EmbeddedServerStartError,
  startEmbeddedServer,
  type EmbeddedServer,
} from "./embedded-server.js";
import { MissingArtifactError, resolveArtifacts } from "./paths.js";
import { planBoot, secretsPath } from "./provisioning.js";
import {
  EncryptionUnavailableError,
  readSecrets,
  SecretsCorruptError,
  writeSecrets,
} from "./secrets.js";
import { buildAdminCliEnv } from "./server-env.js";
import { createMainWindow } from "./window.js";

/** `apps/desktop` — this file lives in its `dist/`. */
const DESKTOP_ROOT = fileURLToPath(new URL("..", import.meta.url));

let server: EmbeddedServer | undefined;
let mainWindow: BrowserWindow | undefined;
let stopping = false;
/** This boot's session, for the preload to pick up (see `preload.cts`). */
let authSeed: SeedDispenser | undefined;

// Answered synchronously, from a value computed before the window exists — the
// preload blocks on this, so it must never do work here.
ipcMain.on(AUTH_SEED_CHANNEL, (event) => {
  event.returnValue = authSeed?.take() ?? null;
});

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
    const { entry, adminCli, webDist } = resolveArtifacts(DESKTOP_ROOT);
    const userData = app.getPath("userData");
    const dataDir = join(userData, "db");
    mkdirSync(dataDir, { recursive: true });

    const serverOptions = {
      entry,
      dataDir,
      webDist,
      clientVersion: app.getVersion(),
    };
    const account = appAccount(app.getName());
    const plan = planBoot({
      stored: readSecrets(secretsPath(userData), safeStorage),
      encryptionAvailable: safeStorage.isEncryptionAvailable(),
    });
    if (plan.kind === "provision") {
      // Three steps that must not overlap, because pglite is
      // single-connection with no lock of its own (spec §3 step 2, MX2):
      //
      //  1. one short server boot, purely to create the schema. The admin CLI
      //     does not migrate — "the server migrates on boot", as its own
      //     header says — and on a first run the database is empty, so
      //     `create-user` would fail on a table that does not exist yet.
      //  2. the CLI, once the server has actually exited (`stop()` waits).
      //  3. the real boot, below.
      const migrator = await startEmbeddedServer({
        ...serverOptions,
        authSecret: plan.secrets.authSecret,
      });
      if (!(await migrator.stop())) {
        throw new Error(
          "The embedded server did not shut down after preparing the database, so the account could not be created safely. Try starting EmberChat again.",
        );
      }
      await provisionAppAccount({
        // Electron's own binary, run as Node — see admin-cli.ts.
        execPath: process.execPath,
        cliEntry: adminCli,
        env: buildAdminCliEnv({
          dataDir,
          authSecret: plan.secrets.authSecret,
        }),
        account,
        password: plan.secrets.appAccountPassword,
      });
      // Only once the account exists: a secrets file written before a failed
      // creation would make the next boot think it had already provisioned.
      writeSecrets(secretsPath(userData), plan.secrets, safeStorage);
    }

    server = await startEmbeddedServer({
      ...serverOptions,
      // Stable across boots (that is what makes a seeded session survive a
      // restart), and it exists only inside the OS keychain.
      authSecret: plan.secrets.authSecret,
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

    // Sign in before the window exists, so the seed is waiting when the
    // preload asks for it.
    authSeed = createSeedDispenser(
      authSeedMessage(
        await loginAppAccount({
          origin: server.origin,
          email: account.email,
          password: plan.secrets.appAccountPassword,
          deviceLabel: deviceLabel(hostname()),
        }),
      ),
    );

    mainWindow = createMainWindow(server.origin);
    mainWindow.on("closed", () => {
      mainWindow = undefined;
    });
  } catch (error) {
    fail(app.getName() + " could not start", describeStartupError(error));
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
  if (error instanceof EncryptionUnavailableError) {
    return error.message;
  }
  if (error instanceof SecretsCorruptError) {
    // Deliberately offers nothing clever: deleting the file forfeits the
    // stored password for the account already in the database, and that is a
    // decision for the person whose computer this is, not for the app. (The
    // next boot's provisioning does know how to adopt an existing account —
    // see admin-cli.ts — but the choice to get there stays the user's.)
    return [
      `The app's stored secrets could not be read (${error.message}).`,
      "",
      `They live in:  ${secretsPath(app.getPath("userData"))}`,
      "",
      "This usually means the file was edited, restored from another machine,",
      "or that the operating system's keychain entry for it is gone. Nothing",
      "has been changed automatically.",
    ].join("\n");
  }
  if (error instanceof AdminCliError) {
    return error.stderr === ""
      ? error.message
      : `${error.message}\n\n${error.stderr}`;
  }
  if (error instanceof DesktopLoginError) {
    return error.message;
  }
  return error instanceof Error
    ? (error.stack ?? error.message)
    : String(error);
}
