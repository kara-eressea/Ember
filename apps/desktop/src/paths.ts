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
