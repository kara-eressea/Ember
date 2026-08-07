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
 * #304 finished the lifecycle (§6). In local mode the window no longer *is* the
 * app: closing it hides it to a tray and the bouncer keeps running, because a
 * chat client whose sessions drop when the window shuts is the thing this whole
 * project exists to fix. Quit — from the tray, the menu, or the OS — is the one
 * path that stops the server child (invariant 6). Thin-client mode is unchanged
 * and deliberately trayless: there is no local bouncer to keep alive there.
 *
 * #305 packaged it (MX4). Nothing about how the app *runs* changed: what
 * changed is where its pieces are, and that is one pure function away in
 * paths.ts — `app.isPackaged` picks between the checkout layout and the flat
 * `resources/` layer electron-builder produces. The version this file hands the
 * server child as `CLIENT_VERSION` now comes from the release tag in a packaged
 * build (`extraMetadata.version`) and stays `0.0.0` in a checkout, per house
 * policy on package.json versions.
 */

import { hostname } from "node:os";
import { mkdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  net,
  Notification,
  safeStorage,
  session,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
} from "electron";
import { AdminCliError, provisionAppAccount } from "./admin-cli.js";
import { appAccount, deviceLabel } from "./app-account.js";
import {
  backupFileName,
  backupSavedMessage,
  BackupError,
  downloadBackup,
  BACKUP_FAILED_TITLE,
  BACKUP_MENU_LABEL,
} from "./backup.js";
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
  carryFlags,
  configPath,
  readConfig,
  sameConfig,
  withTrayNoticeSeen,
  withUpdateCheck,
  writeConfig,
  type DesktopConfig,
} from "./desktop-config.js";
import {
  DesktopLoginError,
  loginAppAccount,
  logoutSession,
  type DesktopSession,
} from "./desktop-login.js";
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
import { installAppMenu, type AppMenuOptions } from "./menu.js";
import {
  assertArtifactsPresent,
  MissingArtifactError,
  resolveArtifactPaths,
} from "./paths.js";
import { installPermissionHandlers } from "./permissions.js";
import { planBoot, provisionFirstRun, secretsPath } from "./provisioning.js";
import {
  EncryptionUnavailableError,
  readSecrets,
  SecretsCorruptError,
  writeSecrets,
} from "./secrets.js";
import { buildAdminCliEnv } from "./server-env.js";
import { forkServerChild } from "./server-fork.js";
import {
  normalizeServerUrl,
  probeServerUrl,
  type ServerUrlResult,
} from "./server-url.js";
import { planStartup, type StartupPlan } from "./startup.js";
import { lifecycleProbe, LIFECYCLE_PROBE_ENV } from "./test-hooks.js";
import { planThinClientLaunch } from "./thin-client.js";
import { updateCheckEnabled, updateCheckNotice } from "./update-check.js";
import { createAppTray, type AppTray } from "./tray.js";
import {
  decideLastWindowClosed,
  decideWindowClose,
  trayNoticeMessage,
  type CloseContext,
  type LifecycleMode,
} from "./tray-model.js";
import { createMainWindow } from "./window.js";

/**
 * `apps/desktop` in a checkout — this file lives in its `dist/`. In a packaged
 * app the same expression names the root of `app.asar`, which is where the
 * main-process JS lives and nothing else does: the static directories, the web
 * dist and the server runtime are all copied out to `resources/` instead (see
 * paths.ts and electron-builder.yml).
 */
const DESKTOP_ROOT = fileURLToPath(new URL("..", import.meta.url));

/** Where this launch's artifacts are — checkout layout or packaged layout. */
const ARTIFACTS = resolveArtifactPaths({
  packaged: app.isPackaged,
  desktopRoot: DESKTOP_ROOT,
  resourcesPath: process.resourcesPath,
  platform: process.platform,
});

let server: EmbeddedServer | undefined;
let mainWindow: BrowserWindow | undefined;
let chooserWindow: BrowserWindow | undefined;
/** The shell's own failure page for a remote session (§5, thin-client only). */
let errorWindow: BrowserWindow | undefined;
/** Whether the open chooser is the first-run question or a later change. */
let chooserReason: "first-run" | "switch" = "first-run";
/** What the app window shows, in whichever mode — also the seed's IPC identity. */
let appOrigin: string | undefined;
/** Reopen the app the way this mode opens it (macOS `activate`, the tray). */
let reopenApp: (() => void) | undefined;
let stopping = false;
/** The system tray — local mode only, and the reason a closed window is not the end. */
let tray: AppTray | undefined;
/** What this launch became; `startup` sets it from the plan (see tray-model.ts). */
let lifecycleMode: LifecycleMode = "choose";
/**
 * Something has asked the app to quit — the tray, the menu, Cmd-Q, the OS
 * logging out. Windows close on the way out rather than hiding, so this is the
 * flag that keeps close-to-tray from turning a quit into a disappearing act.
 */
let quitRequested = false;
/**
 * A backup is running (#548). One at a time: each opens a session and builds
 * the whole archive in memory, and two at once would double both for no gain.
 */
let backupInFlight = false;
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
    : { kind: "page", page: ARTIFACTS.chooserPage };
}

function errorCaller(): IpcCaller | undefined {
  return errorWindow === undefined
    ? undefined
    : { kind: "page", page: ARTIFACTS.errorPage };
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
  // A second launch of an app that is already running: show what is there.
  // With close-to-tray this is also how somebody who forgot the app is in the
  // tray gets their window back — clicking the icon again is the obvious move.
  app.on("second-instance", () => {
    showApp();
  });
  void boot();
}

async function boot(): Promise<void> {
  await app.whenReady();
  // Before any window exists to ask for anything: Electron grants web
  // permissions by default when no handler is installed, and in thin-client
  // mode the window shows an origin this process does not control (#560).
  // Both the default session and any session created later — a partition is
  // one line away, and it would otherwise start from the unsafe default.
  installPermissionHandlers(session.defaultSession);
  app.on("session-created", (created) => {
    installPermissionHandlers(created);
  });
  try {
    await startup(planStartup(readConfig(configPath(app.getPath("userData")))));
  } catch (error) {
    fail(app.getName() + " couldn't start", describeStartupError(error));
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
  //
  // The version rides along because it is the same string the embedded server
  // is handed as `CLIENT_VERSION` and therefore the same one F-Chat sees as
  // `cversion`. In a checkout it is package.json's permanent `0.0.0`; in a
  // release build it is the tag, injected at package time
  // (`extraMetadata.version`, see electron-builder.yml) — which makes this line
  // the packaged smoke test's proof that the injection worked.
  console.log(
    `${app.getName()} ${app.getVersion()} startup: ${plan.kind} (${app.isPackaged ? "packaged" : "checkout"})`,
  );
  // Created here rather than where a session appears, so that "this boot has no
  // seed to give away" is a property of the plan and not of a code path that
  // happens not to have run (see `createSeedHolder`).
  authSeed = createSeedHolder(plan.kind);
  // The lifecycle's own copy of the same answer: what a closing window means
  // is a question about the mode, and it gets asked long after this returns.
  lifecycleMode = plan.kind;
  // Before any window: the menu is per-mode now (#549), and a first run that
  // answers the chooser comes back through here, so the local-mode menu is
  // built by the same line that built the chooser's.
  installAppMenu(appMenuOptions());
  switch (plan.kind) {
    case "choose":
      openChooser("first-run");
      return;
    case "thin-client":
      await startThinClient(plan.serverUrl);
      break;
    case "local":
      await startLocalMode();
      break;
  }
  // Inert unless the environment asks for it (test-hooks.ts).
  runLifecycleProbe();
}

/**
 * What the application menu offers this launch.
 *
 * Everything past "Switch mode…" is local-mode only, because everything past it
 * is about the server this process runs: in thin-client mode that server is
 * somebody else's and its settings are theirs (see `update-check.ts`).
 */
function appMenuOptions(): AppMenuOptions {
  const onSwitchMode = () => {
    openChooser("switch");
  };
  if (lifecycleMode !== "local") {
    return { onSwitchMode };
  }
  return {
    onSwitchMode,
    onBackup: () => {
      void saveBackup();
    },
    updateCheck: {
      enabled: updateCheckEnabled(
        readConfig(configPath(app.getPath("userData"))),
      ),
      onToggle: setUpdateCheck,
    },
  };
}

/**
 * The release-check checkbox, clicked (#549). Persist, then say what happens —
 * nothing on screen changes, and the change lands on the next boot, so silence
 * here would read as a setting that does nothing.
 */
function setUpdateCheck(enabled: boolean): void {
  const path = configPath(app.getPath("userData"));
  const config = readConfig(path);
  if (config === undefined) {
    // No stored config to amend — the file went missing or unreadable under a
    // running app, which the next launch answers by asking again (§4). Put the
    // checkbox back where the file says it is rather than writing a config this
    // process was not asked to write.
    installAppMenu(appMenuOptions());
    return;
  }
  try {
    writeConfig(path, withUpdateCheck(config, enabled));
  } catch (error) {
    console.warn(
      `Could not record the update-check setting in ${path} (${error instanceof Error ? error.message : String(error)}).`,
    );
    // Rebuilt from the file, so the tick matches what is actually stored.
    installAppMenu(appMenuOptions());
    dialog.showErrorBox(
      "That setting couldn't be saved",
      [
        `${app.getName()} could not write down your choice, so nothing has changed.`,
        "",
        `Details: ${path} — ${error instanceof Error ? error.message : String(error)}`,
      ].join("\n"),
    );
    return;
  }
  const { title, body } = updateCheckNotice(app.getName(), enabled);
  void dialog.showMessageBox({
    type: "info",
    title,
    message: title,
    detail: body,
    buttons: ["OK"],
    noLink: true,
  });
}

/**
 * "Save a backup…" (#548), end to end: ask where, sign in, fetch, write.
 *
 * The order is deliberate. The save dialog comes **first** so that changing
 * your mind costs nothing; only once there is somewhere to put the file does
 * this open a session, and it hands that session straight back afterwards
 * (`logoutSession`). Nothing here touches the database directly — it cannot,
 * and `backup.ts`'s module comment is where that is spelled out.
 *
 * The session is minted from the secrets file rather than kept in memory since
 * boot: the app-account password is already on disk under `safeStorage`, and
 * reading it for the two seconds this takes is strictly less exposure than
 * holding it for the life of the process.
 */
async function saveBackup(): Promise<void> {
  const origin = server?.origin;
  if (origin === undefined || backupInFlight) {
    // No local server (or one already busy) means this menu item should not
    // have been reachable; a log line, not a dialog.
    console.warn(
      `Ignoring ${BACKUP_MENU_LABEL} (${origin === undefined ? "no local server" : "one is already running"}).`,
    );
    return;
  }
  const saveOptions = {
    title: `Save a backup of ${app.getName()}`,
    defaultPath: join(
      app.getPath("downloads"),
      backupFileName(app.getName(), new Date()),
    ),
    filters: [{ name: "Backup file", extensions: ["gz"] }],
  };
  // Attached to the window when there is one, so macOS shows it as that
  // window's sheet rather than a box floating over the desktop.
  const chosen =
    mainWindow === undefined || mainWindow.isDestroyed()
      ? await dialog.showSaveDialog(saveOptions)
      : await dialog.showSaveDialog(mainWindow, saveOptions);
  if (chosen.canceled || chosen.filePath === "") {
    return;
  }
  const filePath = chosen.filePath;

  backupInFlight = true;
  let session: DesktopSession | undefined;
  try {
    const secrets = readSecrets(
      secretsPath(app.getPath("userData")),
      safeStorage,
    );
    if (secrets === undefined) {
      throw new BackupError(
        "this computer's private settings file is missing, so the app could not sign in to fetch a backup.",
      );
    }
    session = await loginAppAccount({
      origin,
      email: appAccount(app.getName()).email,
      password: secrets.appAccountPassword,
      deviceLabel: deviceLabel(hostname()),
    });
    const bytes = await downloadBackup({
      origin,
      accessToken: session.accessToken,
    });
    // Written only once every byte is here: a half-file left behind by a
    // failed download is the one outcome a backup feature must not produce.
    try {
      await writeFile(filePath, bytes);
    } catch (cause) {
      // The one failure that cannot claim nothing happened — a full disk can
      // leave a truncated file at the path the user chose.
      throw new BackupError(
        `${filePath} — ${cause instanceof Error ? cause.message : String(cause)}`,
        {
          cause,
          opening:
            "The backup was made, but it could not be written to that location. Check the file that is there before you rely on it; nothing else on this computer has changed.",
        },
      );
    }
    console.log(
      `${app.getName()} backup written: ${String(bytes.byteLength)} bytes.`,
    );
    const { title, body } = backupSavedMessage(app.getName(), filePath);
    void dialog.showMessageBox({
      type: "info",
      title,
      message: title,
      detail: body,
      buttons: ["OK"],
      noLink: true,
    });
  } catch (error) {
    const detail =
      error instanceof BackupError || error instanceof DesktopLoginError
        ? error.message
        : [
            "Nothing was saved, and nothing on this computer has changed.",
            "",
            `Details: ${error instanceof Error ? error.message : String(error)}`,
          ].join("\n");
    console.error(`${BACKUP_FAILED_TITLE}\n${detail}`);
    dialog.showErrorBox(BACKUP_FAILED_TITLE, detail);
  } finally {
    backupInFlight = false;
    if (session !== undefined) {
      await logoutSession({ origin, refreshToken: session.refreshToken });
    }
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
    page: ARTIFACTS.errorPage,
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
  assertArtifactsPresent(ARTIFACTS);
  const userData = app.getPath("userData");
  const dataDir = join(userData, "db");
  mkdirSync(dataDir, { recursive: true });

  // Before the server, not after: a first run spends the better part of a
  // minute provisioning with nothing on screen, and "starting up" in the tray
  // is the only thing this app can say for itself while that happens. It is
  // also the mode's one way back once a window has been closed, so it must
  // exist before any window does.
  installTray();

  const serverOptions = {
    entry: ARTIFACTS.serverEntry,
    dataDir,
    webDist: ARTIFACTS.webDist,
    clientVersion: app.getVersion(),
    // Read once, here, and handed to the child as an environment variable —
    // which is why the menu's checkbox says "next time you open it" (#549).
    updateCheckEnabled: updateCheckEnabled(readConfig(configPath(userData))),
  };
  // The Electron half of starting a child, handed to the Electron-free
  // lifecycle module (embedded-server.ts's module comment says why).
  const serverRuntime = { fork: forkServerChild };
  const account = appAccount(app.getName());
  const plan = planBoot({
    stored: readSecrets(secretsPath(userData), safeStorage),
    encryptionAvailable: safeStorage.isEncryptionAvailable(),
  });
  if (plan.kind === "provision") {
    // Migrate, stop, then the CLI — the ordering lives in provisioning.ts,
    // where it is tested; the real boot follows below.
    await provisionFirstRun({
      appName: app.getName(),
      startMigrator: () =>
        startEmbeddedServer(
          {
            ...serverOptions,
            authSecret: plan.secrets.authSecret,
          },
          serverRuntime,
        ),
      createAccount: () =>
        provisionAppAccount({
          // Electron's own binary, run as Node — see admin-cli.ts.
          execPath: process.execPath,
          cliEntry: ARTIFACTS.adminCli,
          env: buildAdminCliEnv({
            dataDir,
            authSecret: plan.secrets.authSecret,
          }),
          account,
          password: plan.secrets.appAccountPassword,
        }),
      persistSecrets: () => {
        writeSecrets(secretsPath(userData), plan.secrets, safeStorage);
      },
    });
  }

  server = await startEmbeddedServer(
    {
      ...serverOptions,
      // Stable across boots (that is what makes a seeded session survive a
      // restart), and it exists only inside the OS keychain.
      authSecret: plan.secrets.authSecret,
    },
    serverRuntime,
  );
  server.onUnexpectedExit((code) => {
    if (stopping) {
      return;
    }
    fail(
      `${app.getName()} has to close`,
      [
        `The part of ${app.getName()} that keeps you connected stopped, so your characters are no longer online. Everything said so far is saved on this computer and will be here when you start it again.`,
        "",
        `Details: the local server exited with code ${String(code)}.`,
      ].join("\n"),
    );
  });

  // Sign in before the window exists, so the seed is waiting when the
  // preload asks for it.
  const booted = await loginAppAccount({
    origin: server.origin,
    email: account.email,
    password: plan.secrets.appAccountPassword,
    deviceLabel: deviceLabel(hostname()),
  });
  // The seed only: the access token this login also produced belongs to a
  // session the renderer is about to take over and rotate (`auth-seed.ts`), so
  // holding it here would be holding a token that stops working. The backup
  // logs in for itself when it needs one.
  authSeed?.arm(authSeedMessage(booted.seed));

  const origin = server.origin;
  reopenApp = () => {
    openAppWindow(origin);
  };
  openAppWindow(origin);
  // Everything the tray can honestly claim: the child answered /healthz and
  // has not exited since (`onUnexpectedExit` above is what would say otherwise).
  // No poller — §6 asks for a status line, not a monitor.
  tray?.setStatus("running");
}

function openAppWindow(
  origin: string,
  options: { onFailure?: (failure: WindowFailure) => void } = {},
): void {
  appOrigin = origin;
  const window = createMainWindow(origin, options);
  mainWindow = window;
  // The close-to-tray decision, and the only place it is made (§6). Wired to
  // the app window alone: the chooser and the error window always close, which
  // is what `decideWindowClose` answers for them — declining the question and
  // dismissing a failed remote session are both the app being dismissed.
  window.on("close", (event) => {
    const verdict = decideWindowClose("app", closeContext());
    console.log(`${app.getName()} window close: ${verdict}`);
    if (verdict !== "hide-to-tray") {
      return;
    }
    event.preventDefault();
    window.hide();
    // macOS keeps its dock icon (the platform's convention for an app that is
    // still running), Windows loses its taskbar button with the window — both
    // are what `hide()` already does, and neither needs help from here.
    showTrayNoticeOnce();
  });
  window.on("closed", () => {
    if (mainWindow === window) {
      mainWindow = undefined;
    }
  });
}

/** What the close decisions are made against, gathered in one place. */
function closeContext(): CloseContext {
  return {
    mode: lifecycleMode,
    trayPresent: tray !== undefined,
    // `stopping` covers the mode switch's relaunch, which quits without ever
    // going through `before-quit`'s flag.
    quitting: quitRequested || stopping,
  };
}

function installTray(): void {
  if (tray !== undefined) {
    return;
  }
  tray = createAppTray({
    iconPath: ARTIFACTS.trayIcon,
    productName: app.getName(),
    onOpen: showApp,
    onQuit: quitFromTray,
  });
}

/**
 * What the tray's Quit item does — the explicit "go offline" half of the deal
 * (§6). The ordinary quit, deliberately: `before-quit` marks the intent,
 * windows then close instead of hiding, and `will-quit` stops the bouncer. A
 * second stop path here would be a second chance to get invariant 6 wrong.
 */
function quitFromTray(): void {
  console.log(`${app.getName()} quit: from the tray`);
  app.quit();
}

/**
 * Bring the app back — from the tray, the dock, or a second launch.
 *
 * Whatever window this mode has: the app window (hidden behind the tray, or
 * merely behind something else), the chooser, or the error page. With none of
 * them, the mode's own way in — a fresh probe in thin-client mode, the loopback
 * origin in local mode — never a bare `loadURL` of an address nobody checked.
 */
function showApp(): void {
  if (stopping || quitRequested) {
    return;
  }
  const window = mainWindow ?? chooserWindow ?? errorWindow;
  if (window !== undefined && !window.isDestroyed()) {
    if (window.isMinimized()) {
      window.restore();
    }
    window.show();
    window.focus();
    return;
  }
  reopenApp?.();
}

/**
 * The one-time notice (§6): said the first time a window goes to the tray, and
 * never again.
 *
 * A notification rather than a dialog, because the user just closed a window
 * and a modal box appearing in its place would be the app arguing with them.
 * The flag is written only once something was actually shown — on a machine
 * where notifications are unavailable the sentence is still owed, and the next
 * close is welcome to try again.
 */
function showTrayNoticeOnce(): void {
  const path = configPath(app.getPath("userData"));
  const config = readConfig(path);
  if (config === undefined || config.trayNoticeSeen === true) {
    return;
  }
  if (!Notification.isSupported()) {
    return;
  }
  const { title, body } = trayNoticeMessage(app.getName());
  const notification = new Notification({ title, body, silent: true });
  notification.on("click", () => {
    showApp();
  });
  notification.show();
  try {
    writeConfig(path, withTrayNoticeSeen(config, true));
  } catch (error) {
    // Losing this costs one repeated sentence; failing a window close over it
    // would cost the user their window.
    console.warn(
      `Could not record the tray notice in ${path} (${error instanceof Error ? error.message : String(error)}).`,
    );
  }
}

/** How long the lifecycle probe waits before each step (test-hooks.ts). */
const PROBE_STEP_MS = 2_000;

/**
 * The app driving its own close and quit, for a verification run that has no
 * way to click anything. Does nothing at all unless the environment asks.
 */
function runLifecycleProbe(): void {
  const probe = lifecycleProbe(process.env);
  if (probe === undefined) {
    return;
  }
  console.log(
    `${app.getName()} lifecycle probe: ${probe} (${LIFECYCLE_PROBE_ENV})`,
  );
  setTimeout(() => {
    console.log(`${app.getName()} lifecycle probe: closing the window`);
    // Whichever window this launch ended up with — including the error window
    // of a thin-client session that never loaded (§5), which is its own case
    // in the close table and the one hardest to reach by hand.
    (mainWindow ?? errorWindow)?.close();
    if (probe !== "close-then-quit") {
      return;
    }
    setTimeout(() => {
      console.log(`${app.getName()} lifecycle probe: quitting`);
      // The tray's own menu item, called rather than clicked — the point of
      // the probe is that this is the same function, not a similar one.
      quitFromTray();
    }, PROBE_STEP_MS);
  }, PROBE_STEP_MS);
}

function openChooser(reason: "first-run" | "switch"): void {
  chooserReason = reason;
  if (chooserWindow !== undefined) {
    chooserWindow.focus();
    return;
  }
  const current = readConfig(configPath(app.getPath("userData")));
  chooserWindow = createChooserWindow({
    page: ARTIFACTS.chooserPage,
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
    // Carrying the settled-once flags across the rewrite: whether close-to-tray
    // has already introduced itself (§6), and whether the user turned the
    // release check off (#549). Switching away and back is not a reason to
    // explain the tray a second time, nor to start phoning GitHub again.
    writeConfig(path, carryFlags(config, readConfig(path)));
  } catch (error) {
    return {
      ok: false,
      message: `Your choice couldn't be saved, so nothing has changed. Details: ${path} — ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  if (switching) {
    stopping = true;
    // The tray belongs to this process and to local mode; the relaunched
    // instance builds its own if it needs one. Destroyed by hand rather than
    // left to `exit`, so there is no dead icon in the menu bar during the gap
    // — and so that nothing between here and then can decide the app should
    // stay alive because a tray exists (`closeContext`).
    tray?.destroy();
    tray = undefined;
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
    fail(app.getName() + " couldn't start", describeStartupError(error));
    return { ok: false, message: describeStartupError(error) };
  }
  chooserWindow?.close();
  return { ok: true };
}

// Whatever asked — the tray's Quit, the menu, Cmd-Q, the OS shutting down —
// the answer to "is this a quit?" has to be known before the windows start
// closing, or close-to-tray would hide them on the way out and the app would
// never finish leaving.
app.on("before-quit", () => {
  quitRequested = true;
});

// The bouncer is this app's whole point, so its child must not outlive it —
// SIGTERM lets apps/server close Fastify and the database properly. This stays
// the ONLY path that stops the child (spec invariant 6): a closing window in
// local mode hides instead, and #304 changed nothing here.
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

// No windows left. In local mode with a tray that is a normal state — the
// bouncer is running, the tray is the way back — and everywhere else it is the
// end of the app: thin-client mode (no local bouncer to keep alive), a chooser
// declined without an answer, an error window dismissed. `decideLastWindowClosed`
// holds that table; this carries the verdict out.
app.on("window-all-closed", () => {
  const verdict = decideLastWindowClosed(closeContext());
  console.log(`${app.getName()} last window closed: ${verdict}`);
  if (verdict === "quit") {
    app.quit();
  }
});

// macOS: the dock icon clicked, which after a close-to-tray is the other
// obvious way back in (the dock icon stays — an app that is still running says
// so there, and hiding it would leave the menu bar as the only evidence).
app.on("activate", () => {
  showApp();
});

/** A blank window explains nothing; a dialog with the child's own words does. */
function fail(title: string, detail: string): void {
  // The console first, and always. A dialog is for the person at the machine;
  // a log line is for the bug report, and for the one launch where there is
  // nobody to click OK.
  console.error(`${title}\n${detail}`);
  // `showErrorBox` is modal and synchronous: on an automated launch — the
  // packaged smoke test (MX4), a probe run — it waits for a click that will
  // never come, and a failure that should take a second takes the whole
  // timeout. Under the probe the sentence above is the whole report.
  if (lifecycleProbe(process.env) === undefined) {
    dialog.showErrorBox(title, detail);
  }
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
      `${app.getName()} couldn't read the private settings it keeps for this computer, so it stopped rather than guess. Nothing has been changed.`,
      "",
      `They live in:  ${secretsPath(app.getPath("userData"))}`,
      "",
      "This usually means that file was edited or copied from another computer,",
      "or that this computer's keychain no longer has the key for it.",
      "",
      `Details: ${error.message}.`,
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
