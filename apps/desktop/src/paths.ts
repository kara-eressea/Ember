import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * Where the two build artifacts the shell depends on live, and what to say
 * when they don't. Both are produced outside this package: the server runtime
 * by `scripts/build-server-runtime.mjs`, the web dist by the web app's own
 * build. MX4 will add the packaged-app locations beside the dev ones.
 */

/** `apps/desktop/server-runtime` — the deployed, Electron-ABI server tree. */
export function serverRuntimeDir(desktopRoot: string): string {
  return join(desktopRoot, "server-runtime");
}

/**
 * The server's entry inside that tree. `pnpm deploy` roots the *package* at
 * the target directory, so this is `server-runtime/dist/main.js` and not the
 * repo-shaped `apps/server/dist/main.js`.
 */
export function serverRuntimeEntry(desktopRoot: string): string {
  return join(serverRuntimeDir(desktopRoot), "dist", "main.js");
}

/**
 * The admin CLI inside that same tree — how the app account is provisioned on
 * first run (#301). Same rooting rule as the server entry above.
 */
export function adminCliEntry(desktopRoot: string): string {
  return join(serverRuntimeDir(desktopRoot), "dist", "cli", "admin.js");
}

/**
 * The first-run chooser's page (#300). It is not built by anything — three
 * static files that ship as they are — which is why it sits beside `src`
 * rather than in `dist`: `tsc` would neither compile nor copy it, and giving
 * this package a bundler for one HTML file would be the wrong trade.
 */
export function chooserPage(desktopRoot: string): string {
  return join(desktopRoot, "chooser", "index.html");
}

/**
 * The remote session's error page (#302), on the same terms as the chooser:
 * static files that ship as they are, beside `src` rather than in `dist`.
 * These two paths are also the shell's IPC identities — `main.ts` answers the
 * chooser's channels only for the first and the error page's only for the
 * second (see ipc-sender.ts).
 */
export function errorPage(desktopRoot: string): string {
  return join(desktopRoot, "error", "index.html");
}

/**
 * The tray icon (#304), which is two pictures because the two platforms want
 * different ones: a macOS menu-bar icon is a *template* — a black stencil the
 * OS tints for light, dark and selected states — while Windows' notification
 * area shows the app's own artwork. Both are checked in beside the chooser and
 * the error page, on the same terms: static files that ship as they are, from
 * `scripts/generate-tray-icons.mjs`. Electron picks up the `@2x` file beside
 * each one by name, so this returns the 1x path in both cases.
 *
 * Linux is not a target for this release (planning, 2026-08-05); it falls to
 * the Windows artwork, which is also the right answer for the tray areas that
 * do exist there.
 */
export function trayIconPath(
  desktopRoot: string,
  platform: NodeJS.Platform,
): string {
  return join(
    desktopRoot,
    "assets",
    platform === "darwin" ? "trayTemplate.png" : "tray.png",
  );
}

/** The built web app: `apps/web/dist`, one directory over from here. */
export function webDistDir(desktopRoot: string): string {
  return resolve(desktopRoot, "..", "web", "dist");
}

export class MissingArtifactError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MissingArtifactError";
  }
}

/** Both artifacts, or an error naming the command that produces the missing one. */
export function resolveArtifacts(desktopRoot: string): {
  entry: string;
  adminCli: string;
  webDist: string;
} {
  const entry = serverRuntimeEntry(desktopRoot);
  const adminCli = adminCliEntry(desktopRoot);
  if (!existsSync(entry) || !existsSync(adminCli)) {
    throw new MissingArtifactError(
      [
        `The embedded server has not been built yet (${entry} is missing).`,
        "",
        "Build it with:  pnpm --filter @emberchat/desktop server-runtime",
      ].join("\n"),
    );
  }
  const webDist = webDistDir(desktopRoot);
  if (!existsSync(join(webDist, "index.html"))) {
    throw new MissingArtifactError(
      [
        `The web app has not been built yet (${webDist} is missing).`,
        "",
        "Build it with:  pnpm --filter @emberchat/web build",
      ].join("\n"),
    );
  }
  return { entry, adminCli, webDist };
}
