#!/usr/bin/env node
/**
 * The packaged app's smoke test (MX4, #305; design/mx4-packaging.md §4).
 *
 * What it proves, and why it has to be this and not a unit test: a packaged
 * build's failure modes are all about *where things ended up*. A missing
 * `extraResources` entry, a native module that stayed inside the asar, a web
 * dist that never got copied, a version that was not injected — none of those
 * are visible to `tsc`, to vitest, or to `electron .` on a checkout. They are
 * visible the first time the real bundle boots the real bouncer.
 *
 * So this runs the artifact the release train ships:
 *
 *   1. take the installer apart the way a user would — mount the DMG on macOS,
 *      run the NSIS installer silently on Windows (`--unpacked` skips that and
 *      uses electron-builder's staging directory, which is the same tree);
 *   2. seed an isolated `--user-data-dir` with `{"mode":"local"}`, so the
 *      launch goes to local mode instead of stopping at the first-run chooser;
 *   3. launch it with `EMBER_DESKTOP_LIFECYCLE_PROBE=close-then-quit` — the
 *      sanctioned hook (MX3 §6 as-built 6), which is the app calling its own
 *      close and quit rather than anything automating a GUI;
 *   4. assert exit 0 and the probe's own log lines, including the version,
 *      which is the check that `extraMetadata.version` reached
 *      `app.getVersion()` and therefore the embedded server's `CLIENT_VERSION`.
 *
 * That path exercises provisioning end to end: the first run creates the
 * database, runs the admin CLI out of `resources/server-runtime`, encrypts
 * secrets with the OS keychain, boots the bouncer, logs in over loopback and
 * loads the web app out of `resources/web`. Every packaged path except the two
 * a person has to look at (the tray icon rendering, the notification).
 *
 *   node scripts/smoke-packaged.mjs [--version <x.y.z>] [--unpacked] [--keep]
 */

import { spawn, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const desktopDir = fileURLToPath(new URL("..", import.meta.url));
const releaseDir = join(desktopDir, "release");

/** How long the whole launch may take. A first run provisions: two server
 * boots, an argon2 hash and a login, and a cold CI runner is not fast. */
const LAUNCH_TIMEOUT_MS = 5 * 60_000;

/**
 * How long the pipes get to deliver what is left after the app process exits.
 * Short, because by then the interesting output is already written; nonzero,
 * because the last few lines are usually the ones being asserted on.
 */
const EXIT_DRAIN_MS = 2_000;

const args = process.argv.slice(2);
const expectedVersion = valueOf("--version");
const unpackedOnly = args.includes("--unpacked");
const keep = args.includes("--keep");

const workspace = mkdtempSync(join(tmpdir(), "ember-smoke-"));
let mountPoint;

/** Thrown by `fail`; the message has already been printed, so it stays quiet. */
class SmokeFailure extends Error {}

try {
  await main();
} catch (error) {
  if (!(error instanceof SmokeFailure)) {
    console.error(error);
  }
  process.exitCode = 1;
} finally {
  if (mountPoint !== undefined) {
    // Best effort: a busy mount on a CI runner that is about to be destroyed
    // is not worth failing a green run over.
    spawnSync("hdiutil", ["detach", mountPoint, "-quiet"], { stdio: "ignore" });
  }
  if (!keep) {
    rmSync(workspace, { recursive: true, force: true, maxRetries: 5 });
  } else {
    console.log(`smoke: kept ${workspace}`);
  }
}

async function main() {
  const binary = unpackedOnly ? stagedBinary() : installedBinary();
  console.log(`smoke: launching ${binary}`);

  const userData = join(workspace, "user-data");
  mkdirSync(userData, { recursive: true });
  // Straight to local mode. Without this the launch stops at the first-run
  // chooser — which is a window nothing here may click, and which never
  // reaches the probe (`startup` returns before it for `choose`).
  writeFileSync(
    join(userData, "config.json"),
    `${JSON.stringify({ version: 1, mode: "local" }, undefined, 2)}\n`,
  );

  const { code, signal, output } = await launch(binary, userData);
  console.log("── app output ──────────────────────────────────────────────");
  console.log(output.trimEnd());
  console.log("────────────────────────────────────────────────────────────");

  const problems = [];
  if (code !== 0) {
    problems.push(
      `exited with code ${String(code)}${signal === null ? "" : ` (signal ${signal})`}, expected 0`,
    );
  }
  for (const expected of expectations()) {
    if (!expected.pattern.test(output)) {
      problems.push(`no line matching ${expected.what}`);
    }
  }
  if (problems.length > 0) {
    fail(["the packaged app did not behave:", ...problems].join("\n  "));
  }
  console.log("smoke: packaged app booted, closed to tray and quit cleanly");
}

/**
 * What the run has to have said. Each one is a claim about the packaged layout
 * and not merely about the shell's logic:
 *
 *  • the startup line proves the app booted at all *and* carries the version
 *    that was injected at package time (`--version` makes that an assertion);
 *  • "local" proves the seeded config was read and the bouncer path was taken,
 *    which is the path that needs `resources/server-runtime` and `resources/web`;
 *  • "packaged" proves `app.isPackaged` picked the packaged branch of paths.ts
 *    rather than accidentally resolving against a checkout;
 *  • hide-to-tray proves the tray exists in the bundle (a missing icon resource
 *    throws where the tray is built) and that close-to-tray survived packaging;
 *  • the quit line proves the tray's own Quit path ran, which is the only path
 *    that stops the server child (invariant 6).
 */
function expectations() {
  const version =
    expectedVersion === undefined
      ? "\\S+"
      : expectedVersion.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return [
    {
      what: `the startup line at version ${expectedVersion ?? "(any)"}, in local mode, packaged`,
      pattern: new RegExp(`\\s${version} startup: local \\(packaged\\)`),
    },
    {
      what: "the probe announcing itself",
      pattern: /lifecycle probe: close-then-quit/,
    },
    {
      what: "the window closing to the tray",
      pattern: /window close: hide-to-tray/,
    },
    { what: "the tray's own Quit path", pattern: /quit: from the tray/ },
  ];
}

function launch(binary, userData) {
  return new Promise((resolveLaunch, rejectLaunch) => {
    const child = spawn(binary, [`--user-data-dir=${userData}`], {
      env: {
        ...process.env,
        EMBER_DESKTOP_LIFECYCLE_PROBE: "close-then-quit",
        // Never inherited into the embedded bouncer anyway (the shell builds a
        // complete env for its child), but a developer's shell should not be
        // able to change what this test is testing either.
        DATABASE_URL: undefined,
        AUTH_SECRET: undefined,
      },
      // Windows: the app is a GUI-subsystem binary, which has no console of its
      // own — but spawned with real pipes it writes to them normally. That is
      // why this is `pipe` and not an inherited terminal, and why `windowsHide`
      // is deliberately left off: it puts SW_HIDE in the child's STARTUPINFO,
      // and the one thing this test must not do is start the app with its
      // window suppressed.
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    const collect = (chunk) => {
      output += String(chunk);
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);

    let settled = false;
    const finish = (code, signal) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      clearTimeout(drain);
      resolveLaunch({ code, signal, output });
    };

    // `exit` rather than `close`, plus a short grace period for the pipes.
    //
    // `close` waits for every writer on the child's stdout and stderr to let
    // go, and this app has more writers than the process we spawned: the
    // bouncer runs as a utility process that inherited those pipes, and
    // Chromium has helpers of its own. A killed app leaves them holding the
    // handles, so waiting for `close` after a timeout is waiting forever —
    // which turns "the app misbehaved" into "the CI step hung".
    let drain;
    child.on("exit", (code, signal) => {
      drain = setTimeout(() => {
        finish(code, signal);
      }, EXIT_DRAIN_MS);
    });
    child.on("close", finish);

    const timer = setTimeout(() => {
      output += "\nsmoke: timed out; killing the app\n";
      killTree(child);
    }, LAUNCH_TIMEOUT_MS);

    child.on("error", (error) => {
      clearTimeout(timer);
      console.error(`smoke: could not launch ${binary}: ${error.message}`);
      rejectLaunch(new SmokeFailure(error.message));
    });
  });
}

/**
 * Kill the app and everything it started.
 *
 * `child.kill` signals one process. What is on screen is a process *tree* — the
 * bouncer, Chromium's helpers — and on Windows there are no process groups to
 * signal, so the only way to take the tree down is to ask the OS by name.
 * Failing to do this leaves an orphaned bouncer holding a port and a data
 * directory on the runner.
 */
function killTree(child) {
  if (process.platform === "win32" && child.pid !== undefined) {
    spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
    });
    return;
  }
  child.kill("SIGKILL");
}

// ── Finding the thing to launch ──────────────────────────────────────────────

/**
 * The installer, taken apart the way the user takes it apart. This is the
 * stronger of the two routes and the default, because it is the only one that
 * says anything about the DMG and the NSIS script themselves.
 */
function installedBinary() {
  return process.platform === "darwin" ? fromDmg() : fromNsis();
}

function fromDmg() {
  const dmg = onlyArtifact(".dmg");
  mountPoint = join(workspace, "mnt");
  mkdirSync(mountPoint, { recursive: true });
  run("hdiutil", [
    "attach",
    dmg,
    "-mountpoint",
    mountPoint,
    "-nobrowse",
    "-readonly",
    "-quiet",
  ]);
  const bundle = readdirSync(mountPoint).find((entry) =>
    entry.endsWith(".app"),
  );
  if (bundle === undefined) {
    fail(`${dmg} contains no .app bundle`);
  }
  // Copied off the read-only image before launching: this is what dragging it
  // to Applications does, and it is also the only way the app can be launched
  // without the disk image staying mounted underneath it.
  const target = join(workspace, bundle);
  cpSync(join(mountPoint, bundle), target, {
    recursive: true,
    verbatimSymlinks: true,
  });
  return join(target, "Contents", "MacOS", appName(bundle));
}

function fromNsis() {
  const installer = onlyArtifact(".exe");
  const target = join(workspace, "install");
  // NSIS silent install into a directory of our choosing. `/S` is
  // electron-builder's own silent switch and `/D=` (last argument, unquoted —
  // NSIS's own rule, not a shell one) is where it goes; a per-user install
  // needs no elevation, which is the whole point of `perMachine: false`.
  run(installer, ["/S", `/D=${target}`]);
  const exe = readdirSync(target).find((entry) => entry.endsWith(".exe"));
  if (exe === undefined) {
    fail(`${installer} installed nothing executable into ${target}`);
  }
  return join(target, exe);
}

/** electron-builder's staging tree — the same files, before packaging. */
function stagedBinary() {
  const dirs = readdirSync(releaseDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^(mac|win)/.test(entry.name))
    .map((entry) => join(releaseDir, entry.name));
  for (const dir of dirs) {
    if (process.platform === "darwin") {
      const bundle = readdirSync(dir).find((entry) => entry.endsWith(".app"));
      if (bundle !== undefined) {
        return join(dir, bundle, "Contents", "MacOS", appName(bundle));
      }
    } else {
      const exe = readdirSync(dir).find((entry) => entry.endsWith(".exe"));
      if (exe !== undefined) {
        return join(dir, exe);
      }
    }
  }
  return fail(`no unpacked app under ${releaseDir}`);
}

/** `EmberChat.app` → `EmberChat`; the executable inside carries the same name. */
function appName(bundle) {
  return bundle.replace(/\.app$/, "");
}

/**
 * The one artifact with this extension. "One" is an assertion rather than a
 * convenience: two DMGs in the output directory means a stale build is sitting
 * beside the new one, and picking either would make this test a coin toss.
 */
function onlyArtifact(extension) {
  if (!existsSync(releaseDir)) {
    return fail(`${releaseDir} does not exist — run the packaging step first`);
  }
  const found = readdirSync(releaseDir)
    .filter((entry) => entry.endsWith(extension))
    .map((entry) => join(releaseDir, entry));
  if (found.length !== 1) {
    return fail(
      found.length === 0
        ? `no ${extension} in ${releaseDir}`
        : `${String(found.length)} ${extension} files in ${releaseDir}; expected exactly one:\n  ${found.join("\n  ")}`,
    );
  }
  return found[0];
}

function valueOf(flag) {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

function run(command, commandArgs) {
  const result = spawnSync(command, commandArgs, { stdio: "inherit" });
  if (result.error) {
    fail(`${command} could not be run: ${result.error.message}`);
  }
  if (result.status !== 0) {
    fail(`${command} failed with exit code ${String(result.status)}`);
  }
}

function fail(message) {
  console.error(`smoke: ${message}`);
  // Thrown rather than `process.exit`, so the `finally` above still runs: a
  // mounted disk image and a temp tree outlive this process otherwise.
  throw new SmokeFailure(message);
}
