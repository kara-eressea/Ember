#!/usr/bin/env node
/**
 * Builds `apps/desktop/server-runtime/` — the bouncer as the desktop app runs
 * it (design/mx3-desktop-shell.md §1).
 *
 * The problem this script exists to solve: the embedded server runs inside
 * Electron's `utilityProcess`, so its native modules (argon2, re2) must be
 * built against Electron's ABI — and that rebuild is a ONE-WAY TRIP. A tree
 * rebuilt for Electron can no longer run under plain Node, which means it can
 * no longer run `vitest` (design/mx2-pglite-spike.md §Q3). So the workspace's
 * own `node_modules` must never be rebuilt (spec invariant 1), and this script
 * is written so that it cannot be: every path it writes to is asserted to live
 * inside `server-runtime/` or the throwaway pglite stage next to it, the
 * runtime tree is stripped of every symlink that leads out of it before the
 * rebuilder walks it, and the workspace's native binaries are fingerprinted
 * (size + mtime) before the rebuild and verified unchanged after it.
 *
 * The steps:
 *   1. `pnpm --filter @emberchat/server --prod deploy` — a self-contained prod
 *      tree, the same shape the Docker image ships.
 *   2. install `@electric-sql/pglite` into it. The server keeps pglite as a
 *      devDependency (the image prunes ~25 MB of WASM it can never use), but
 *      the desktop runtime is the consumer that genuinely needs it.
 *   3. `@electron/rebuild` over that tree only, for argon2 and re2, against
 *      the Electron version this package depends on.
 *
 * Cached on a stamp file: the server's build mtime, the Electron version and
 * the pglite spec. Re-run it any time — it is a no-op when nothing moved.
 *
 *   node scripts/build-server-runtime.mjs [--force]
 */

import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseStamp, runtimeBuildDecision } from "./runtime-stamp.mjs";

const desktopDir = fileURLToPath(new URL("..", import.meta.url));
const repoRoot = resolve(desktopDir, "..", "..");
const serverDir = join(repoRoot, "apps", "server");
const runtimeDir = join(desktopDir, "server-runtime");
const stageDir = join(desktopDir, "server-runtime.pglite-stage");
const stampFile = join(desktopDir, "server-runtime.stamp.json");

/** The two native modules; everything else in the tree is portable JS/WASM. */
const NATIVE_MODULES = ["argon2", "re2"];
/** Where the workspace keeps the copies that must survive untouched. */
const WORKSPACE_MODULES = join(repoRoot, "node_modules");
/** pnpm's record of how this workspace was last installed — see below. */
const INSTALL_STATE = join(WORKSPACE_MODULES, ".pnpm-workspace-state-v1.json");

const force = process.argv.includes("--force");

await main();

async function main() {
  const electronVersion = readElectronVersion();
  const pgliteSpec = readPgliteSpec();
  const next = {
    serverBuiltAtMs: newestMtimeMs([
      join(serverDir, "dist"),
      join(serverDir, "drizzle"),
      join(serverDir, "package.json"),
    ]),
    electronVersion,
    pgliteSpec,
  };

  const { stale, reason } = runtimeBuildDecision({
    runtimePresent: existsSync(join(runtimeDir, "dist", "main.js")),
    previous: readStamp(),
    next,
  });
  if (!stale && !force) {
    console.log(`server-runtime: ${reason} — nothing to do`);
    return;
  }
  console.log(
    `server-runtime: rebuilding (${force ? "--force" : reason}) for electron ${electronVersion}`,
  );

  const fingerprint = nativeFingerprint(WORKSPACE_MODULES);
  const installState = readWorkspaceInstallState();

  removeInsideDesktop(runtimeDir);
  try {
    deployServer();
  } finally {
    restoreWorkspaceInstallState(installState);
  }
  installPglite(pgliteSpec);
  sealRuntimeTree();
  await rebuildForElectron(electronVersion);

  assertWorkspaceUntouched(fingerprint);

  writeFileSync(stampFile, `${JSON.stringify(next, null, 2)}\n`);
  console.log(`server-runtime: ready — ${relative(repoRoot, runtimeDir)}`);
}

/**
 * `pnpm --prod deploy` records `dev: false` in the workspace's install state,
 * and the *next* pnpm command in this repo then decides the workspace is a
 * production install and offers to purge `node_modules` (in CI, without a TTY,
 * it simply fails). Snapshotting that one file and putting the exact same
 * bytes back is the whole repair — the only write this script makes outside
 * apps/desktop, and it is a restore, not a change.
 */
function readWorkspaceInstallState() {
  return existsSync(INSTALL_STATE)
    ? readFileSync(INSTALL_STATE, "utf8")
    : undefined;
}

function restoreWorkspaceInstallState(contents) {
  if (contents === undefined || !existsSync(INSTALL_STATE)) {
    return;
  }
  if (readFileSync(INSTALL_STATE, "utf8") !== contents) {
    writeFileSync(INSTALL_STATE, contents);
  }
}

/** Step 1: the prod tree, exactly as the container image is assembled. */
function deployServer() {
  // --legacy: deploying without injected workspace packages, which is the
  // default this workspace uses (pnpm ≥ 10 asks for the flag explicitly).
  // --config.package-import-method=copy: no hardlinks back into the pnpm
  // store. A hardlinked .node file rebuilt in place would rewrite the store's
  // copy — i.e. the workspace's copy — which is precisely invariant 1's
  // failure mode. Copies make that impossible rather than unlikely.
  run(
    pnpmBin(),
    [
      "--filter",
      "@emberchat/server",
      "--prod",
      "deploy",
      "--legacy",
      "--config.package-import-method=copy",
      // --config.node-linker=hoisted: a flat `node_modules` of real
      // directories, with no symlinks anywhere in it (MX4, #305).
      //
      // pnpm's default store layout links every package from `.pnpm`, and
      // those links do not survive being packaged. electron-builder recreates
      // them with `fs.symlink`, which on Windows needs a privilege an ordinary
      // user does not have; pnpm writes junctions rather than symlinks there in
      // the first place, so the two ends do not even agree on what kind of link
      // it is; and an NSIS installer has no way to represent either. Hoisting
      // makes the whole question disappear on both targets, and it is what
      // MX3's "sealed and relocatable" property was really reaching for: a tree
      // that can be copied anywhere, by anything, and still resolve.
      "--config.node-linker=hoisted",
      runtimeDir,
    ],
    repoRoot,
  );
}

/**
 * Step 2: pglite into the deployed tree.
 *
 * Not `pnpm add` inside that tree, which the spec sketched: the deployed
 * manifest keeps its `workspace:*` specs, so any install run in that directory
 * tries to re-resolve them against a workspace that isn't there and fails
 * (ERR_PNPM_WORKSPACE_PKG_NOT_FOUND). Instead pglite is installed in a
 * one-dependency scratch project — hoisted, so the result is a plain directory
 * — and copied in. pglite has no dependencies of its own; anything it grew
 * would ride along the same way.
 */
function installPglite(spec) {
  removeInsideDesktop(stageDir);
  writeInsideDesktop(
    join(stageDir, "package.json"),
    `${JSON.stringify(
      {
        name: "emberchat-desktop-pglite-stage",
        version: "0.0.0",
        private: true,
        dependencies: { "@electric-sql/pglite": spec },
      },
      null,
      2,
    )}\n`,
  );
  run(
    pnpmBin(),
    [
      "install",
      "--ignore-workspace",
      "--no-lockfile",
      "--config.node-linker=hoisted",
      "--config.package-import-method=copy",
    ],
    stageDir,
  );

  const staged = join(stageDir, "node_modules");
  for (const entry of readdirSync(staged)) {
    if (entry.startsWith(".")) {
      continue;
    }
    copyInsideRuntime(
      join(staged, entry),
      join(runtimeDir, "node_modules", entry),
    );
  }
  removeInsideDesktop(stageDir);
}

/**
 * Between steps 2 and 3: close the tree.
 *
 * A deployed pnpm tree contains one symlink that points back out of itself —
 * `node_modules/.pnpm/node_modules/@emberchat/server` → `apps/server`, pnpm's
 * hoist alias for the very project it deployed. @electron/rebuild resolves
 * symlinks to their real paths while walking (its module-walker.js does
 * `fs.realpath` on every entry and recurses into whatever `node_modules` it
 * finds there), so that single link is a doorway from this tree straight into
 * the workspace's own `node_modules` — and walking through it rebuilds the
 * workspace's argon2 and re2 against Electron's ABI. That is invariant 1's
 * exact failure mode, and it happened on this script's first run: the
 * workspace's re2 came back `NODE_MODULE_VERSION 148` and `pnpm test` could no
 * longer load it.
 *
 * Severing every escaping link closes the door structurally rather than by
 * configuration: with no path out of the tree, nothing that walks it can leave.
 * Hoist aliases are never load-bearing (every real dependency is inside this
 * tree's own `.pnpm`), and a tree with no outward links is relocatable — which
 * is what MX4's packaging step needs anyway.
 */
function sealRuntimeTree() {
  for (const link of escapingSymlinks(runtimeDir)) {
    console.log(
      `server-runtime: severing link out of the tree — ${relative(runtimeDir, link)}`,
    );
    assertInsideDesktop(link);
    severLink(link);
  }
  const remaining = escapingSymlinks(runtimeDir);
  if (remaining.length > 0) {
    fail(
      [
        "these symlinks still lead out of server-runtime; the Electron rebuild could follow them:",
        ...remaining.map((link) => `  ${relative(runtimeDir, link)}`),
      ].join("\n"),
    );
  }
}

/**
 * Remove one link without following it — the *link*, never what it points at.
 *
 * `unlink` is the whole answer on macOS and Linux, where a symlink to a
 * directory is still just a link. On Windows a directory link (pnpm makes
 * junctions there, and `mklink /D` symlinks elsewhere) is a directory-shaped
 * reparse point: `unlink` refuses it with EPERM/EISDIR and `rmdir` is what
 * removes it — without touching the tree on the far side, which is the property
 * that matters here. `rmSync({ recursive: true })` would be the obvious
 * one-liner and is exactly what must not be used: on a link it is one Node
 * version away from deleting the workspace's own `node_modules`.
 */
function severLink(path) {
  try {
    unlinkSync(path);
  } catch (error) {
    if (error.code !== "EPERM" && error.code !== "EISDIR") {
      throw error;
    }
    rmdirSync(path);
  }
}

/**
 * Every link under `root` whose target resolves outside `root`.
 *
 * "Link" rather than "symlink" on purpose: on Windows pnpm materialises
 * `node_modules` entries as **junctions**, not symbolic links. Both are reparse
 * points, libuv reports both as `UV_DIRENT_LINK`, and so `isSymbolicLink()` is
 * true for a junction too — which is what makes this walk mean the same thing
 * on both packaging targets. `isDirectory()` is correspondingly false for them,
 * so the recursion below never goes *through* a link either.
 */
function escapingSymlinks(root) {
  const escaping = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        let target;
        try {
          target = realpathSync(path);
        } catch {
          continue; // Dangling links lead nowhere, which is where we want them.
        }
        const relation = relative(root, target);
        if (relation.startsWith("..") || relation === "") {
          escaping.push(path);
        }
      } else if (entry.isDirectory()) {
        walk(path);
      }
    }
  };
  walk(root);
  return escaping;
}

/** Step 3: the one-way rebuild — over `server-runtime/` and nothing else. */
async function rebuildForElectron(electronVersion) {
  const { rebuild } = await import("@electron/rebuild");
  await rebuild({
    buildPath: runtimeDir,
    // Without this, @electron/rebuild walks upwards looking for a project
    // root and would find the workspace. Pinned to the runtime tree.
    projectRootPath: runtimeDir,
    electronVersion,
    onlyModules: NATIVE_MODULES,
    force: true,
  });
}

function readElectronVersion() {
  const require = createRequire(import.meta.url);
  const manifest = JSON.parse(
    readFileSync(require.resolve("electron/package.json"), "utf8"),
  );
  return String(manifest.version);
}

function readPgliteSpec() {
  const manifest = JSON.parse(
    readFileSync(join(serverDir, "package.json"), "utf8"),
  );
  const spec = manifest.devDependencies?.["@electric-sql/pglite"];
  if (typeof spec !== "string") {
    fail(
      "apps/server no longer declares @electric-sql/pglite — the desktop runtime needs a version to install",
    );
  }
  return spec;
}

/** Newest mtime under the given files/directories, recursively. */
function newestMtimeMs(paths) {
  let newest = 0;
  for (const path of paths) {
    if (!existsSync(path)) {
      fail(
        `${relative(repoRoot, path)} is missing — build the server first:\n\n  pnpm --filter @emberchat/server build`,
      );
    }
    const stats = statSync(path);
    newest = Math.max(newest, stats.mtimeMs);
    if (stats.isDirectory()) {
      newest = Math.max(
        newest,
        newestMtimeMs(readdirSync(path).map((entry) => join(path, entry))),
      );
    }
  }
  return Math.round(newest);
}

function readStamp() {
  if (!existsSync(stampFile)) {
    return undefined;
  }
  try {
    return parseStamp(JSON.parse(readFileSync(stampFile, "utf8")));
  } catch {
    return undefined;
  }
}

/**
 * size+mtime of every native binary in the workspace, so a leaked rebuild is
 * caught by this script rather than by a mystifying "invalid ELF header" in
 * someone's next `pnpm test` run.
 */
function nativeFingerprint(root) {
  const found = new Map();
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(path);
      } else if (entry.isFile() && entry.name.endsWith(".node")) {
        const stats = statSync(path);
        found.set(path, `${String(stats.size)}:${String(stats.mtimeMs)}`);
      }
    }
  };
  walk(root);
  return found;
}

function assertWorkspaceUntouched(before) {
  const after = nativeFingerprint(WORKSPACE_MODULES);
  const changed = [...before]
    .filter(([path, signature]) => after.get(path) !== signature)
    .map(([path]) => relative(repoRoot, path));
  if (changed.length > 0) {
    fail(
      [
        "the Electron rebuild escaped into the workspace's node_modules — invariant 1 violated.",
        "Restore it before running the test suite:  pnpm install --force",
        "",
        ...changed.map((path) => `  ${path}`),
      ].join("\n"),
    );
  }
}

// ── Guarded filesystem writes ────────────────────────────────────────────────
// Every mutating call in this script goes through one of these, and each one
// refuses a target outside apps/desktop. This is the mechanical half of
// invariant 1: not "we remembered to be careful", but "the script cannot".

function assertInsideDesktop(path) {
  const relation = relative(desktopDir, path);
  if (relation === "" || relation.startsWith("..") || resolve(path) !== path) {
    fail(`refusing to write outside apps/desktop: ${path}`);
  }
}

function removeInsideDesktop(path) {
  assertInsideDesktop(path);
  // The retries are for Windows: a `node_modules` tree this size is routinely
  // still held by an indexer or a virus scanner a few milliseconds after the
  // process that wrote it exited, and the failure is a transient EBUSY/EPERM
  // rather than a real one. A no-op everywhere else.
  rmSync(path, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 100,
  });
}

function writeInsideDesktop(path, contents) {
  assertInsideDesktop(path);
  const parent = resolve(path, "..");
  assertInsideDesktop(parent);
  mkdirSync(parent, { recursive: true });
  writeFileSync(path, contents);
}

function copyInsideRuntime(from, to) {
  const relation = relative(runtimeDir, to);
  if (relation === "" || relation.startsWith("..")) {
    fail(`refusing to copy outside server-runtime: ${to}`);
  }
  cpSync(from, to, { recursive: true, dereference: true, force: true });
}

function pnpmBin() {
  return process.platform === "win32" ? "pnpm.cmd" : "pnpm";
}

/**
 * Run a command, with the one thing Windows insists on.
 *
 * corepack's `pnpm` on Windows is `pnpm.cmd`, a batch file — and since the
 * BatBadBut fix (Node 18.20.2/20.12.2/21.7.3, CVE-2024-27980) `spawn` refuses a
 * `.cmd`/`.bat` target outright with EINVAL unless `shell: true` is set. That
 * flag then hands the whole line to `cmd.exe`, which does its own word
 * splitting, so the arguments have to be quoted here: `runtimeDir` is an
 * absolute path and a checkout under "My Documents" would otherwise arrive as
 * two arguments. Nothing changes on macOS or Linux, where `pnpm` is an ordinary
 * executable and the argv array is passed through untouched.
 */
function run(command, args, cwd) {
  const windowsShell = process.platform === "win32" && command.endsWith(".cmd");
  const result = spawnSync(
    command,
    windowsShell ? args.map(quoteForCmd) : args,
    { cwd, stdio: "inherit", shell: windowsShell },
  );
  if (result.error) {
    fail(`${command} could not be run: ${result.error.message}`);
  }
  if (result.status !== 0) {
    fail(
      `${command} ${args.join(" ")} failed with exit code ${String(result.status)}`,
    );
  }
}

/** Quote anything cmd.exe would split or interpret; leave plain words alone. */
function quoteForCmd(arg) {
  return /^[A-Za-z0-9_\-.:\\/=@]+$/.test(arg) ? arg : `"${arg}"`;
}

function fail(message) {
  console.error(`server-runtime: ${message}`);
  process.exit(1);
}
