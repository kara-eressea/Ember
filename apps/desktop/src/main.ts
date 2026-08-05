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
 * asks (§4).
 *
 * #302 finished thin-client mode (§5), which is the mode where the window shows
 * a machine this process does not control: every launch probes `/healthz`
 * before `loadURL`, a load that fails gets the shell's own error page with
 * Retry and Switch mode on it (never Chromium's, and never a certificate the
 * user can click past), and every IPC channel checks who is calling before it
 * answers — an untrusted renderer is a real thing to defend against once the
 * main window is somebody else's origin.
 *
 * Not here yet: the tray and close-to-tray lifecycle (#304), packaging (MX4).
 */

import { hostname } from "node:os";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  net,
  safeStorage,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
} from "electron";
import { AdminCliError, provisionAppAccount } from "./admin-cli.js";
import { appAccount, deviceLabel } from "./app-account.js";
import {
  authSeedMessage,
  createSeedHolder,
  AUTH_SEED_CHANNEL,
  type SeedHolder,
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
import {
  REMOTE_RETRY_CHANNEL,
  REMOTE_SWITCH_MODE_CHANNEL,
  type RemoteActionResult,
} from "./error-ipc.js";
import {
  describeWindowFailure,
  isIgnorableLoadFailure,
  type RemoteFailure,
  type WindowFailure,
} from "./error-page.js";
import { createErrorWindow, showErrorPage } from "./error-window.js";
import { senderAllowed, type IpcCaller } from "./ipc-sender.js";
import { installAppMenu } from "./menu.js";
import {
  chooserPage,
  errorPage,
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
import {
  normalizeServerUrl,
  probeServerUrl,
  type ServerUrlResult,
} from "./server-url.js";
import { planStartup, type StartupPlan } from "./startup.js";
import { planThinClientLaunch } from "./thin-client.js";
import { createMainWindow } from "./window.js";

/** `apps/desktop` — this file lives in its `dist/`. */
const DESKTOP_ROOT = fileURLToPath(new URL("..", import.meta.url));

let server: EmbeddedServer | undefined;
let mainWindow: BrowserWindow | undefined;
let chooserWindow: BrowserWindow | undefined;
/** The shell's own failure page for a remote session (§5, thin-client only). */
let errorWindow: BrowserWindow | undefined;
/** Whether the open chooser is the first-run question or a later change. */
let chooserReason: "first-run" | "switch" = "first-run";
/** What the app window shows, in whichever mode — also the seed's IPC identity. */
let appOrigin: string | undefined;
/** Reopen the app the way this mode opens it (macOS `activate`). */
let reopenApp: (() => void) | undefined;
let stopping = false;
/**
 * This boot's session for the preload to pick up (see `preload.cts`) — created
 * from the startup plan, so a boot that has no business holding one *cannot*
 * (`createSeedHolder`). Thin-client mode's answer is always `null`.
 */
let authSeed: SeedHolder | undefined;

// ── IPC ─────────────────────────────────────────────────────────────────────
//
// Five channels, and every one of them checks who is calling first.
//
// `ipcMain` is process-wide: a handler registered for the chooser is reachable
// from any renderer in the app, including — in thin-client mode — the main
// window, which shows a server this process does not control. Nothing in that
// window has a bridge to reach these with today (the app window's preload
// exposes nothing, and `contextIsolation` keeps `ipcRenderer` out of the page's
// world), so this is the second lock rather than the first. It is worth having
// because the first lock is one Chromium bug away from being off, and because
// the cost is a boolean.

// Answered synchronously, from a value computed before the window exists — the
// preload blocks on this, so it must never do work here. Both branches set
// `returnValue`: a `sendSync` that is never answered hangs the renderer before
// its first paint.
ipcMain.on(AUTH_SEED_CHANNEL, (event) => {
  // The app window at the origin this process chose to show, and nothing else.
  // In thin-client mode the answer is `null` whatever the sender (there is no
  // session to hand over), but the check is the same one either way.
  if (!senderIs(event, mainWindow, appOriginCaller())) {
    refused(AUTH_SEED_CHANNEL, event);
    event.returnValue = null;
    return;
  }
  event.returnValue = authSeed?.take() ?? null;
});

// The chooser's two calls (chooser-ipc.ts). Both answer with a sentence rather
// than throwing: a refusal is something the user reads and acts on.
ipcMain.handle(CHOOSE_LOCAL_CHANNEL, (event) => {
  if (!senderIs(event, chooserWindow, chooserCaller())) {
    refused(CHOOSE_LOCAL_CHANNEL, event);
    return { ok: false, message: NOT_OUR_PAGE } satisfies ChoiceResult;
  }
  return applyChoice({ mode: "local" });
});
ipcMain.handle(CHOOSE_THIN_CLIENT_CHANNEL, async (event, raw: unknown) => {
  if (!senderIs(event, chooserWindow, chooserCaller())) {
    refused(CHOOSE_THIN_CLIENT_CHANNEL, event);
    return { ok: false, message: NOT_OUR_PAGE } satisfies ChoiceResult;
  }
  const normalized = normalizeServerUrl(typeof raw === "string" ? raw : "");
  if (!normalized.ok) {
    return { ok: false, message: normalized.message } satisfies ChoiceResult;
  }
  // From the MAIN process, never the page: the chooser is a file:// document
  // whose CSP allows no network at all, and a renderer fetch would be answering
  // a CORS question instead of a reachability one.
  const reachable = await probeRemote(normalized.url);
  if (!reachable.ok) {
    return { ok: false, message: reachable.message } satisfies ChoiceResult;
  }
  return applyChoice({ mode: "thin-client", serverUrl: normalized.url });
});

// The error page's two calls (error-ipc.ts). Retry re-runs the launch — probe
// first, then the window — so a server that has come back is shown, and one
// that has come back *differently* (a certificate that expired while it was
// down) says so in place.
ipcMain.handle(REMOTE_RETRY_CHANNEL, async (event) => {
  if (!senderIs(event, errorWindow, errorCaller())) {
    refused(REMOTE_RETRY_CHANNEL, event);
    return { ok: false, failure: REFUSED_FAILURE } satisfies RemoteActionResult;
  }
  const config = readConfig(configPath(app.getPath("userData")));
  if (config?.mode !== "thin-client") {
    // The config changed underneath this window (hand-edited, or a switch that
    // has not relaunched yet). Ask rather than guess — that is #300's whole
    // recovery story, and this window has the button for it.
    return {
      ok: false,
      failure: {
        headline: "That server is no longer the one configured",
        detail: `The stored setup in ${configPath(app.getPath("userData"))} no longer names a server to connect to. Use “Switch mode…” to choose again.`,
      },
    } satisfies RemoteActionResult;
  }
  const launch = await planThinClientLaunch(config.serverUrl, probeRemote);
  if (launch.kind === "error") {
    return { ok: false, failure: launch.failure } satisfies RemoteActionResult;
  }
  openAppWindow(launch.serverUrl, thinClientHooks(launch.serverUrl));
  // Only now: closing the last window quits the app (`window-all-closed`), so
  // the replacement has to exist before the thing it replaces goes.
  closeErrorWindow();
  return { ok: true } satisfies RemoteActionResult;
});

ipcMain.handle(REMOTE_SWITCH_MODE_CHANNEL, (event) => {
  if (!senderIs(event, errorWindow, errorCaller())) {
    refused(REMOTE_SWITCH_MODE_CHANNEL, event);
    return { ok: false, failure: REFUSED_FAILURE } satisfies RemoteActionResult;
  }
  openChooser("switch");
  closeErrorWindow();
  return { ok: true } satisfies RemoteActionResult;
});

/** Shown to a page that is not ours; the real pages never see it. */
const NOT_OUR_PAGE = "That request did not come from this app's own window.";
const REFUSED_FAILURE: RemoteFailure = {
  headline: "That request wasn't from this window",
  detail: NOT_OUR_PAGE,
};

/**
 * Whether this message came from the window and the document it should have.
 *
 * Two checks, because each catches what the other cannot: the `webContents`
 * identity refuses *a different window* (any other renderer in the app), and
 * `senderAllowed` refuses *this window showing a different document* — a frame
 * that has navigated somewhere else, or a subframe inside it.
 */
function senderIs(
  event: IpcMainEvent | IpcMainInvokeEvent,
  window: BrowserWindow | undefined,
  expected: IpcCaller | undefined,
): boolean {
  if (
    window === undefined ||
    window.isDestroyed() ||
    event.sender !== window.webContents
  ) {
    return false;
  }
  const frame = event.senderFrame;
  return senderAllowed(
    frame === null || frame === undefined
      ? undefined
      : { url: frame.url, topFrame: frame.parent === null },
    expected,
  );
}

function chooserCaller(): IpcCaller | undefined {
  return chooserWindow === undefined
    ? undefined
    : { kind: "page", page: chooserPage(DESKTOP_ROOT) };
}

function errorCaller(): IpcCaller | undefined {
  return errorWindow === undefined
    ? undefined
    : { kind: "page", page: errorPage(DESKTOP_ROOT) };
}

function appOriginCaller(): IpcCaller | undefined {
  return appOrigin === undefined
    ? undefined
    : { kind: "origin", origin: appOrigin };
}

/**
 * One line for a message this process would not answer.
 *
 * The sender's *origin* only, never its full URL: in thin-client mode that URL
 * belongs to the user's own server and can carry whatever it likes in a query
 * string. What a bug report needs is which channel and roughly who — not a
 * path out of somebody's private instance.
 */
function refused(
  channel: string,
  event: IpcMainEvent | IpcMainInvokeEvent,
): void {
  const url = event.senderFrame?.url ?? "";
  let origin: string;
  try {
    origin = new URL(url).origin;
  } catch {
    origin = "an unidentifiable frame";
  }
  console.warn(`Refused ${channel} from ${origin}.`);
}

/**
 * The `/healthz` probe, on Electron's network stack rather than Node's.
 *
 * This matters for exactly one question and it is the one §5 cares most about:
 * which certificates count. `net.fetch` uses the same Chromium stack — the same
 * system trust store, the same proxy settings — that the window is about to
 * use, so the probe accepts a server if and only if the window would have. With
 * Node's own `fetch` (its own bundled CA list) a certificate the OS trusts but
 * Node does not would refuse a server that would have loaded perfectly.
 */
function probeRemote(serverUrl: string): Promise<ServerUrlResult> {
  return probeServerUrl(serverUrl, {
    // Wrapped rather than passed by reference: `net.fetch` is a method on
    // Electron's `net`, and handing it over detached would separate it from
    // its own `this`.
    fetch: (input, init) => net.fetch(input as string, init),
  });
}

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
    await startup(planStartup(readConfig(configPath(app.getPath("userData")))));
  } catch (error) {
    fail(app.getName() + " could not start", describeStartupError(error));
  }
}

/**
 * The three answers `planStartup` can give (spec §4).
 *
 * Resolves once the launch has a window (or the chooser does), which is what
 * lets `applyChoice` hold the chooser open until then — see there.
 */
async function startup(plan: StartupPlan): Promise<void> {
  // One line on the console so a dev run — and a bug report from somebody
  // whose app opened the wrong thing — says which of the three paths a launch
  // took. The mode is not a secret; the server's address is not printed with
  // it, since that is the one part of this config somebody might not want in
  // a pasted log.
  console.log(`${app.getName()} startup: ${plan.kind}`);
  // Created here rather than where a session appears, so that "this boot has no
  // seed to give away" is a property of the plan and not of a code path that
  // happens not to have run (see `createSeedHolder`).
  authSeed = createSeedHolder(plan.kind);
  switch (plan.kind) {
    case "choose":
      openChooser("first-run");
      return;
    case "thin-client":
      await startThinClient(plan.serverUrl);
      return;
    case "local":
      await startLocalMode();
      return;
  }
}

/**
 * Thin-client mode (§5): no server, no provisioning, no seeding — the window
 * shows the user's own instance and the web app there does its own login.
 *
 * The probe comes first on *every* launch, not just the one where the address
 * was typed. An address that answered last week is not evidence about today,
 * and the alternative is a blank window until Chromium's own timeout expires,
 * ending on somebody else's error page. `planThinClientLaunch` holds that
 * decision (and the tests for it); this carries the answer out.
 */
async function startThinClient(serverUrl: string): Promise<void> {
  reopenApp = () => {
    void startThinClient(serverUrl);
  };
  const launch = await planThinClientLaunch(serverUrl, probeRemote);
  if (launch.kind === "window") {
    openAppWindow(serverUrl, thinClientHooks(serverUrl));
    closeErrorWindow();
    return;
  }
  openErrorWindow(serverUrl, launch.failure);
}

/**
 * What the app window does when it cannot show a remote origin at all.
 *
 * Only thin-client mode passes these. The failure surface is the shell's
 * because the alternative is Chromium's: a page that names neither this app nor
 * the address, offers no way back, and on a bad certificate is a wall with a
 * button on it that must not exist here.
 */
function thinClientHooks(serverUrl: string): {
  onFailure: (failure: WindowFailure) => void;
} {
  return {
    onFailure: (failure) => {
      // A cancelled or superseded navigation is not a failure to show anybody.
      if (isIgnorableLoadFailure(failure)) {
        return;
      }
      openErrorWindow(serverUrl, describeWindowFailure(serverUrl, failure));
      // After the error window exists (`window-all-closed` quits), and
      // `destroy` rather than `close`: a window whose renderer has just died
      // has nobody left to run a close handler.
      const broken = mainWindow;
      mainWindow = undefined;
      broken?.destroy();
    },
  };
}

function openErrorWindow(serverUrl: string, failure: RemoteFailure): void {
  // One line, for the same reason the startup path logs one: a bug report from
  // somebody whose app showed this page should say which failure it was. The
  // code and the headline only — the server's address stays out of a log that
  // might get pasted somewhere, exactly as at startup.
  console.warn(
    `${app.getName()} remote session unavailable: ${failure.code ?? "-"} (${failure.headline})`,
  );
  const options = {
    page: errorPage(DESKTOP_ROOT),
    productName: app.getName(),
    serverUrl,
    failure,
  };
  if (errorWindow !== undefined) {
    // Already up (a retry that failed differently, or a second failure from a
    // window that was reopening): re-state it rather than stack windows.
    showErrorPage(errorWindow, options);
    errorWindow.focus();
    return;
  }
  errorWindow = createErrorWindow(options);
  errorWindow.on("closed", () => {
    errorWindow = undefined;
  });
}

function closeErrorWindow(): void {
  const window = errorWindow;
  errorWindow = undefined;
  window?.close();
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
  authSeed?.arm(
    authSeedMessage(
      await loginAppAccount({
        origin: server.origin,
        email: account.email,
        password: plan.secrets.appAccountPassword,
        deviceLabel: deviceLabel(hostname()),
      }),
    ),
  );

  const origin = server.origin;
  reopenApp = () => {
    openAppWindow(origin);
  };
  openAppWindow(origin);
}

function openAppWindow(
  origin: string,
  options: { onFailure?: (failure: WindowFailure) => void } = {},
): void {
  appOrigin = origin;
  mainWindow = createMainWindow(origin, options);
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
 * On a first run the app carries straight on into the chosen mode — nothing
 * has started yet, so there is nothing to unwind. The chooser stays on screen
 * until that mode has a window of its own, for two reasons: `window-all-closed`
 * quits the app, and a first local boot spends a good few seconds provisioning
 * with nothing else open — closing the chooser first would quit the app in the
 * middle of it. It also means the page keeps its busy state until there is
 * something to look at instead.
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
  if (
    switching &&
    sameConfig(readConfig(path), config) &&
    mainWindow !== undefined
  ) {
    // Re-picking what is already running: close the window and change nothing.
    //
    // "Already running" is the load-bearing half. Reached from the error page
    // (§5) there is no app window, and re-picking the same address is not a
    // no-op — it is the user saying "try that again". Falling through to the
    // relaunch below is exactly what they asked for, where closing the chooser
    // would leave no windows at all and quit the app.
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

  if (switching) {
    stopping = true;
    // Armed *first*: anything that quits the app between here and `exit` —
    // a stray `window-all-closed`, the `will-quit` path — would otherwise end
    // the process for good instead of restarting it into the new mode.
    app.relaunch();
    // A clean SIGTERM before the process goes: pglite is a file on this user's
    // disk, not a server somebody else runs. The windows go with `exit`; there
    // is nothing to close by hand.
    await (server?.stop() ?? Promise.resolve());
    server = undefined;
    app.exit(0);
    return { ok: true };
  }

  try {
    await startup(planStartup(config));
  } catch (error) {
    // The chooser is still up behind the dialog; `fail` ends the process, so
    // what this answers with only decides what a still-alive page would show.
    fail(app.getName() + " could not start", describeStartupError(error));
    return { ok: false, message: describeStartupError(error) };
  }
  chooserWindow?.close();
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
    errorWindow === undefined &&
    reopenApp !== undefined &&
    !stopping
  ) {
    // Whatever this mode's way in is — the loopback origin, or a fresh probe of
    // the remote one. Never a bare `loadURL` of an address nobody has checked.
    reopenApp();
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
