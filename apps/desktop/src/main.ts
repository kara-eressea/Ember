/**
 * EmberChat desktop — Electron main process (MX3, design/mx3-desktop-shell.md).
 *
 * What this process is: a window, a lifecycle, and — in local mode — a bouncer
 * running beside it. The embedded server (the same `apps/server` code a
 * self-hoster deploys) runs as a `utilityProcess` on 127.0.0.1 with pglite as
 * its database, and the window simply loads that origin. There is no renderer
 * bundle here and never will be — the renderer *is* the web app, byte for byte.
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
 * #300 put the fork in front of all of that: `<userData>/config.json` says
 * which mode this install runs in, and when it says nothing the chooser window
 * asks (§4). Thin-client mode (§5) is #302's to finish — what is here is the
 * naive shape the chooser's choice already implies: the window loads the
 * remote URL under the same navigation policy, with no server and no
 * provisioning behind it.
 *
 * Not here yet: the tray and close-to-tray lifecycle (#304), packaging (MX4).
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
import {
  CHOOSE_LOCAL_CHANNEL,
  CHOOSE_THIN_CLIENT_CHANNEL,
  type ChoiceResult,
} from "./chooser-ipc.js";
import { createChooserWindow } from "./chooser-window.js";
import {
  configPath,
  readConfig,
  sameConfig,
  writeConfig,
  type DesktopConfig,
} from "./desktop-config.js";
import { DesktopLoginError, loginAppAccount } from "./desktop-login.js";
import {
  EmbeddedServerStartError,
  startEmbeddedServer,
  type EmbeddedServer,
} from "./embedded-server.js";
import { installAppMenu } from "./menu.js";
import {
  chooserPage,
  MissingArtifactError,
  resolveArtifacts,
} from "./paths.js";
import { planBoot, secretsPath } from "./provisioning.js";
import {
  EncryptionUnavailableError,
  readSecrets,
  SecretsCorruptError,
  writeSecrets,
} from "./secrets.js";
import { buildAdminCliEnv } from "./server-env.js";
import { normalizeServerUrl, probeServerUrl } from "./server-url.js";
import { planStartup, type StartupPlan } from "./startup.js";
import { createMainWindow } from "./window.js";

/** `apps/desktop` — this file lives in its `dist/`. */
const DESKTOP_ROOT = fileURLToPath(new URL("..", import.meta.url));

let server: EmbeddedServer | undefined;
let mainWindow: BrowserWindow | undefined;
let chooserWindow: BrowserWindow | undefined;
/** Whether the open chooser is the first-run question or a later change. */
let chooserReason: "first-run" | "switch" = "first-run";
/** What the app window shows, in whichever mode — for `activate` on macOS. */
let appOrigin: string | undefined;
let stopping = false;
/** This boot's session, for the preload to pick up (see `preload.cts`). */
let authSeed: SeedDispenser | undefined;

// Answered synchronously, from a value computed before the window exists — the
// preload blocks on this, so it must never do work here. In thin-client mode
// there is nothing to hand over (the remote server does its own login), and
// the same preload asks the same question and is told `null`.
ipcMain.on(AUTH_SEED_CHANNEL, (event) => {
  event.returnValue = authSeed?.take() ?? null;
});

// The chooser's two calls (chooser-ipc.ts). Both answer with a sentence rather
// than throwing: a refusal is something the user reads and acts on.
ipcMain.handle(CHOOSE_LOCAL_CHANNEL, () => applyChoice({ mode: "local" }));
ipcMain.handle(CHOOSE_THIN_CLIENT_CHANNEL, async (_event, raw: unknown) => {
  const normalized = normalizeServerUrl(typeof raw === "string" ? raw : "");
  if (!normalized.ok) {
    return { ok: false, message: normalized.message } satisfies ChoiceResult;
  }
  // From the MAIN process, never the page: the chooser is a file:// document
  // whose CSP allows no network at all, and a renderer fetch would be answering
  // a CORS question instead of a reachability one.
  const reachable = await probeServerUrl(normalized.url);
  if (!reachable.ok) {
    return { ok: false, message: reachable.message } satisfies ChoiceResult;
  }
  return applyChoice({ mode: "thin-client", serverUrl: normalized.url });
});

// FIRST, before anything reads or writes the user data directory: pglite
// takes no lock of its own, so two instances on one data directory is
// corruption, not inconvenience (spec invariant 5, MX2 §Q4).
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const window = mainWindow ?? chooserWindow;
    if (window === undefined) {
      return;
    }
    if (window.isMinimized()) {
      window.restore();
    }
    window.focus();
  });
  void boot();
}

async function boot(): Promise<void> {
  await app.whenReady();
  try {
    installAppMenu(() => {
      openChooser("switch");
    });
    startup(planStartup(readConfig(configPath(app.getPath("userData")))));
  } catch (error) {
    fail(app.getName() + " could not start", describeStartupError(error));
  }
}

/** The three answers `planStartup` can give (spec §4). */
function startup(plan: StartupPlan): void {
  // One line on the console so a dev run — and a bug report from somebody
  // whose app opened the wrong thing — says which of the three paths a launch
  // took. The mode is not a secret; the server's address is not printed with
  // it, since that is the one part of this config somebody might not want in
  // a pasted log.
  console.log(`${app.getName()} startup: ${plan.kind}`);
  switch (plan.kind) {
    case "choose":
      openChooser("first-run");
      return;
    case "thin-client":
      // #302's job is the rest of this: error surfaces when the remote goes
      // away, and whatever hardening a window pointed at someone else's origin
      // turns out to need. What the chooser's choice already implies is one
      // line — the same window, the same navigation policy, a different origin.
      openAppWindow(plan.serverUrl);
      return;
    case "local":
      void startLocalMode().catch((error: unknown) => {
        fail(app.getName() + " could not start", describeStartupError(error));
      });
      return;
  }
}

/** Everything §2 and §3 describe: provision if needed, boot, log in, show. */
async function startLocalMode(): Promise<void> {
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

  openAppWindow(server.origin);
}

function openAppWindow(origin: string): void {
  appOrigin = origin;
  mainWindow = createMainWindow(origin);
  mainWindow.on("closed", () => {
    mainWindow = undefined;
  });
}

function openChooser(reason: "first-run" | "switch"): void {
  chooserReason = reason;
  if (chooserWindow !== undefined) {
    chooserWindow.focus();
    return;
  }
  const current = readConfig(configPath(app.getPath("userData")));
  chooserWindow = createChooserWindow({
    page: chooserPage(DESKTOP_ROOT),
    productName: app.getName(),
    serverUrl: current?.mode === "thin-client" ? current.serverUrl : undefined,
  });
  chooserWindow.on("closed", () => {
    chooserWindow = undefined;
  });
}

/**
 * Persist the chooser's answer and act on it.
 *
 * On a first run the app simply carries on into the chosen mode — nothing has
 * started yet, so there is nothing to unwind.
 *
 * A later change relaunches instead. `app.relaunch()` + `exit` is the simplest
 * honest implementation and it is chosen deliberately: local mode leaves a
 * server child, a provisioned account and a seeded session behind it, and
 * tearing all of that down in place would mean maintaining a second, subtler
 * boot path whose only user is a switch nobody makes twice a day. A relaunch
 * gives the new mode exactly the clean start a fresh launch gets. The local
 * data directory is left alone either way (spec §4): parting with history is a
 * deliberate act, and this is not it.
 */
async function applyChoice(config: DesktopConfig): Promise<ChoiceResult> {
  const path = configPath(app.getPath("userData"));
  const switching = chooserReason === "switch";
  if (switching && sameConfig(readConfig(path), config)) {
    // Re-picking what is already running: close the window and change nothing.
    chooserWindow?.close();
    return { ok: true };
  }

  try {
    writeConfig(path, config);
  } catch (error) {
    return {
      ok: false,
      message: `That choice could not be saved to ${path} (${error instanceof Error ? error.message : String(error)}).`,
    };
  }

  chooserWindow?.close();

  if (switching) {
    stopping = true;
    // A clean SIGTERM before the process goes: pglite is a file on this user's
    // disk, not a server somebody else runs.
    await (server?.stop() ?? Promise.resolve());
    server = undefined;
    app.relaunch();
    app.exit(0);
    return { ok: true };
  }

  startup(planStartup(config));
  return { ok: true };
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
// closing the window with no way to get it back has to mean quitting. It is
// also how the chooser is declined: closing it without answering quits, and
// nothing has been written.
app.on("window-all-closed", () => {
  app.quit();
});

app.on("activate", () => {
  if (
    mainWindow === undefined &&
    chooserWindow === undefined &&
    appOrigin !== undefined &&
    !stopping
  ) {
    openAppWindow(appOrigin);
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
