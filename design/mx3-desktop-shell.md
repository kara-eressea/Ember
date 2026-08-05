# MX3 — The desktop shell

*Implementation spec, written 2026-08-05 after MX2 closed. Covers issues
#299 (scaffold + loopback boot), #300 (mode chooser), #301 (provisioning +
secrets), #302 (thin-client mode), #304 (tray). Packaging/installers are MX4
(#305, #306) and none of this document builds them — but the scaffold's
artifact pipeline is shaped so MX4 packages what MX3 already runs. Standing
decisions honored here: embedded bouncer on loopback (standalone-client.md),
first-run mode chooser + close-to-tray + **no auto-updater in v1** (planned
2026-07-22), unsigned macOS + Windows on the shared release train (planned
2026-08-05). The MX2 facts this leans on: pglite needs a **single-instance
lock as correctness** (no data-dir lock of its own), `DB_DRIVER=pglite` +
`PGLITE_DATA_DIR` boot the real server, and **an Electron-ABI rebuild is
one-way** — a tree rebuilt for Electron cannot run the Node test suite
(design/mx2-pglite-spike.md).*

## Shape: a thin main process, no renderer code

`apps/desktop` is an Electron **main process + preload only**. There is no
renderer bundle and never will be: the renderer is the existing web app,
served by the embedded server on loopback and loaded with
`win.loadURL("http://127.0.0.1:<port>")` — byte-for-byte the deployment
shape, which is the whole point of the embedded-bouncer decision. The window
chrome, tray, and lifecycle are the entire UI surface this package owns
(plus one first-run chooser window, §4).

Out of the workspace's TypeScript project references it stays simple: plain
`tsc` build, `electron .` to run. Vite/HMR buys nothing for a process this
small.

## 1. The server artifact — solving the one-way ABI problem (#299)

The embedded server runs as an Electron `utilityProcess` (Electron's
supported Node child), which means its native deps (`argon2`, `re2`) must be
Electron-ABI — and the spike proved a rebuilt tree can no longer serve
`vitest`. The workspace tree must therefore **never** be rebuilt. Instead:

- `apps/desktop/scripts/build-server-runtime.mjs` produces
  `apps/desktop/server-runtime/` (gitignored):
  1. `pnpm --filter @emberchat/server deploy` — a self-contained prod tree
     (dist + pruned prod deps), the same shape the Docker image uses;
  2. `pnpm add @electric-sql/pglite` **inside that tree** — the server keeps
     pglite as a devDependency (the image prunes it; MX2), but the desktop
     runtime is exactly the consumer that needs it for real;
  3. `@electron/rebuild` over that tree only (`argon2`, `re2`), against the
     workspace's Electron version.
- The workspace tree stays Node-ABI forever; `pnpm test` and the desktop
  app coexist on one machine. The script is cached on a stamp file (server
  dist mtime + Electron version) and re-run by `desktop:dev`.
- The web dist rides along: `WEB_DIST` points at `apps/web/dist` in dev and
  at a copied `resources/web` in the packaged app (MX4's concern).

### As built (#299)

Four things the sketch above did not know, all found by building it:

1. **The deploy needs `--legacy`** (pnpm ≥ 10 otherwise refuses a workspace
   that isn't `inject-workspace-packages`), and it roots the *package* at the
   target — so the entry is `server-runtime/dist/main.js`, not a repo-shaped
   `apps/server/dist/main.js`. It also records `dev: false` in the workspace's
   install state, which makes the *next* pnpm command in the repo want to purge
   `node_modules`; the script snapshots that one file and puts it back.
2. **`pnpm add` inside the deployed tree cannot work.** The deployed manifest
   keeps its `workspace:*` specs, so any install run in that directory tries to
   re-resolve them and dies (`ERR_PNPM_WORKSPACE_PKG_NOT_FOUND`). pglite is
   installed in a one-dependency scratch project (hoisted, so it materializes
   as a plain directory) and copied in.
3. **Invariant 1 has a specific mechanism, and it fired on the first run.** A
   deployed pnpm tree contains exactly one symlink out of itself —
   `node_modules/.pnpm/node_modules/@emberchat/server` → `apps/server`, pnpm's
   hoist alias for the project it just deployed. `@electron/rebuild` resolves
   symlinks to real paths as it walks, went through that door into the
   workspace, and rebuilt the workspace's `argon2` and `re2` for Electron
   (`NODE_MODULE_VERSION 148`; `pnpm test` then couldn't load them). The script
   now severs every escaping symlink before rebuilding and asserts none remain,
   deploys with `--config.package-import-method=copy` so nothing is hardlinked
   back to the pnpm store, and fingerprints the workspace's `.node` files
   around the rebuild — the check that caught this.
4. **Electron ≥ 43 has no install script at all**; the ~100 MB binary is
   fetched lazily on the first `electron .`. So CI needs no opt-out beyond the
   `electron: false` entry in `pnpm-workspace.yaml`'s `allowBuilds`.

Cost on this machine: ~80 s cold (~70 s of it the rebuild), a no-op when the
stamp matches. The stamp is server dist/drizzle/manifest mtime + Electron
version + pglite spec.

## 2. Loopback boot (#299)

- The shell picks a free port itself (bind `127.0.0.1:0`, read, close —
  the standard race-accepted probe), then forks the runtime's `main.js` via
  `utilityProcess.fork` with env, not flags: `DB_DRIVER=pglite`,
  `PGLITE_DATA_DIR=<userData>/db`, `HOST=127.0.0.1`, `PORT=<port>`,
  `APP_BASE_URL=http://127.0.0.1:<port>` (this is what admits the renderer
  origin to the gateway allowlist — app.ts already loopback-aliases it),
  `WEB_DIST`, `AUTH_SECRET` (§3), `RETENTION_POLICY=forever` default.
- Readiness = polling `/healthz` (the image smoke test's contract); a crash
  before ready surfaces the child's stderr in a dialog rather than a blank
  window. The child dies with the app (`will-quit` → kill, and the child
  watches its parent's disconnect as the backstop).
- **Single-instance lock first**: `app.requestSingleInstanceLock()` before
  anything touches the data dir; the second instance focuses the first and
  exits. This is correctness, not politeness — pglite will happily corrupt a
  shared data dir (MX2).

As built, the child's environment is *complete* rather than a patch over
`process.env`: a developer's shell has `DATABASE_URL` and `AUTH_SECRET` in it,
and neither may reach the embedded bouncer. The full set is `NODE_ENV`,
`DB_DRIVER`, `PGLITE_DATA_DIR`, `HOST`, `PORT`, `APP_BASE_URL`, `WEB_DIST`,
`AUTH_SECRET`, `RETENTION_POLICY`, `CLIENT_VERSION` — everything else stays at
its schema default. `productName: "EmberChat"` in the package manifest is what
puts the data dir at `<userData>/db` under a human name instead of under the
package's npm name.

## 3. First-run provisioning + secrets (#301)

First run in local mode, before the server ever boots:

1. Generate `AUTH_SECRET` (32 random bytes) and an app-account password
   (random, never shown); username `desktop`, email a config-derived
   placeholder (the account is a login row on the user's own machine, not an
   identity).
2. Create the account through the **admin CLI code path** — the runtime's
   `cli/admin.js create-user --password-stdin` run as a one-shot
   `utilityProcess` against the same env. Sequential with the server boot,
   never concurrent (single-connection pglite).
3. Persist both secrets with `safeStorage.encryptString` to
   `<userData>/secrets.json` (fail closed if `isEncryptionAvailable()` is
   false: tell the user the OS keychain is unavailable rather than writing
   plaintext).

Every later boot: decrypt, boot server, **log in from the main process**
(`POST /api/auth/login` on loopback with a desktop `deviceLabel`), and hand
the session to the renderer by seeding the web app's own persisted-auth
localStorage key (`eb.auth`, shape per `apps/web/src/stores/auth.ts`) from
the preload before the page's scripts run. The renderer wakes up already
signed in — the user never sees the app's login screen, exactly as the
design promised; the F-List password prompt (memory-only vault, unchanged)
remains the only credential interaction.

### As built (#301)

1. **The admin CLI child is not a `utilityProcess`.** A utility process has no
   writable stdin — Electron's own docs: "Configuring `stdin` to any property
   other than `ignore` is not supported and will result in an error", and
   `UtilityProcess` exposes only `stdout`/`stderr`. `--password-stdin` is not
   negotiable (argv is readable by every process on the host, as the CLI's own
   header says), so the child is `child_process.spawn(process.execPath, …)`
   with `ELECTRON_RUN_AS_NODE=1`: the same Electron runtime a utility process
   gets — same `NODE_MODULE_VERSION`, so `server-runtime`'s Electron-ABI
   `argon2` loads — but an ordinary Node child, with a stdin. Everything else
   holds: same complete env (`buildAdminCliEnv`, no ambient inheritance),
   sequential with the server, exit code asserted, stderr into the dialog.
2. **The seed travels over `ipcRenderer.sendSync`.** Only synchronous work can
   hold the window between the preload and the page's scripts. The alternative,
   `additionalArguments`, would put a live refresh token on the renderer
   process's command line, where `ps` can read it. A sandboxed (`sandbox:
   true`) preload can do this: `ipcRenderer` is available there, and the
   isolated world shares the page's `localStorage`. The `sandbox: false` +
   `.mjs` fallback the scaffold flagged was not needed.
3. **One seed per boot, and it always wins.** The main process hands the seed
   to whoever asks first and returns `null` after that. Once, because the store
   rotates the seeded token as it boots — a reload re-writing the spent one
   would log the user out. Always, because the localStorage a previous boot
   left behind may hold an expired or evicted session, while this boot's login
   is known good.
4. **First run boots the server twice.** The admin CLI does not migrate ("the
   server migrates on boot", per its own header), and a first run's database is
   empty, so `create-user` fails on a table that does not exist. The server
   therefore gets one short boot to create the schema and is stopped —
   `stop()` now reports whether the child is confirmed gone, and provisioning
   refuses to continue if it is not — before the CLI opens the same directory.
   Second and later boots start the server exactly once.
5. **A half-finished first run heals itself; a corrupt secrets file does not.**
   If the CLI created the account but the secrets file never landed, the next
   boot's `create-user` fails with "already taken" and provisioning falls back
   to `reset-password` for the same account — nothing is destroyed, the
   password is machine-generated and never shown. A secrets file that exists
   but will not decode stays a hard error with the file's path in it: deleting
   it is the user's call, not the app's.
6. Login is a plain `fetch` from the main process; a fresh auth-session row per
   boot is absorbed by the M7 per-user session cap (25, evicted by
   `lastSeenAt`). No session reuse, no second secret to store.

## 4. First-run mode chooser (#300)

A small dedicated window (the one piece of shell-owned UI; plain HTML/CSS in
`apps/desktop`, styled with the design-system tokens, no framework): **"Use
locally"** (embedded bouncer, everything above) or **"Connect to my
server"** (thin client, §5, takes a URL). The choice and the URL persist in
`<userData>/config.json` (not a secret). Switching later is a menu item —
"Switch mode…" reopens the chooser; switching away from local **does not
delete the local data dir** (parting with history is a deliberate act; a
"delete local data" affordance can come with MX4's polish if wanted).

## 5. Thin-client mode (#302)

The window loads the remote instance's URL directly — the whole web app
comes from the user's self-hosted server, login screen and all, exactly like
a browser tab with an app frame around it. No embedded server, no
provisioning, no localStorage seeding. Validation on entry: fetch
`<url>/healthz` and refuse with a legible message otherwise. External links
(profile links etc.) open in the system browser in both modes
(`setWindowOpenHandler`); navigation away from the app origin is refused.

## 6. Tray + lifecycle (#304)

- **Local mode:** window close hides to tray; the bouncer keeps running —
  that IS the product. Tray: app name + status, Open, Quit. Explicit Quit
  stops the server child cleanly (SIGTERM → the existing graceful close) and
  exits. The dock/taskbar reflects hidden state per-platform conventions
  (macOS: keep dock icon, standard; Windows: tray icon).
- **Thin-client mode:** close quits. There is no local bouncer to keep
  alive, and the remote one doesn't need this process — pretending
  otherwise would be tray theater.
- First close in local mode shows a one-time notice ("still running in the
  tray — your sessions stay online"), the honest-deal line the design doc
  asked the UI to say out loud.

## 7. What MX3 explicitly does not do

- No packaging/installers/signing (MX4).
- No auto-updater: the web app's existing update surface (M7's release
  check via `/api/meta`) already renders inside the embedded shell and
  serves as the download hint — nothing new needed in v1.
- No multi-device listening beyond loopback (a future opt-in, per design).
- No macOS/Windows platform-specific polish beyond what tray conventions
  require (MX4).

## Invariants

1. The workspace `node_modules` is never Electron-rebuilt; only
   `server-runtime/` is. A leaked rebuild is the "invalid ELF/ABI" class of
   failure the spike documented — the build script must be the only writer.
2. The renderer is the unmodified web app; `apps/desktop` contains no
   renderer JS beyond the preload seed. Any desktop-conditional behavior in
   `apps/web` needs its own justification and review.
3. The embedded server binds `127.0.0.1` only; the origin allowlist stays
   derived from `APP_BASE_URL`. Never `0.0.0.0`.
4. Secrets exist only under `safeStorage`; no plaintext fallback.
5. The single-instance lock precedes any data-dir access.
6. Local-mode Quit is the only path that stops the server child; window
   close never does.

## Issue cut

- **#299**: package scaffold, `build-server-runtime` pipeline, free-port
  boot, `/healthz` readiness, window on loopback, single-instance lock,
  child lifecycle. Provisional hardcoded local mode (chooser comes next).
- **#301**: provisioning flow, safeStorage, main-process login + preload
  auth seeding. After this lands the app is usable end-to-end in local mode.
- **#300**: the chooser window + config persistence + switch-mode menu item.
- **#302**: thin-client mode behind the chooser.
- **#304**: tray + lifecycle + the one-time notice.

#299 → #301 are sequential; #300/#302/#304 can follow in any order but land
one at a time (each is small). Testing: the shell's logic (port probe,
provisioning sequencing, config persistence) is plain Node — unit-testable
with vitest in `apps/desktop` without booting Electron; whole-app E2E waits
for MX4's packaged builds (Playwright's Electron driver is worth a look
then, not now). Every PR targets `staging`.
