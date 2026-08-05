import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * Where the artifacts the shell depends on live, and what to say when one of
 * them doesn't.
 *
 * There are two answers, and MX4 (#305) is where the second one arrives. In a
 * checkout the pieces sit where their builders leave them: the server runtime
 * and the three static directories under `apps/desktop`, the web dist one
 * package over in `apps/web/dist`. In a packaged app they are all one flat
 * layer in `Contents/Resources` (macOS) / `resources` (Windows), because
 * `electron-builder.yml` copies each of them there by name — see the
 * `extraResources` block, which is the other half of this file.
 *
 * The whole resolution is one pure function over four facts, so the packaged
 * layout is testable on a machine that has never packaged anything. Nothing
 * here touches the filesystem except `assertArtifactsPresent`, which is the one
 * question that genuinely needs the disk.
 *
 * Two things deliberately do NOT appear here. The main-process JS is inside
 * `app.asar` and finds itself relative to its own module URL; and the tray
 * icon's `@2x` companion is found by Electron beside the 1x path this returns
 * (which is why the 1x file is what gets resolved).
 */

export interface ArtifactLocation {
  /** `app.isPackaged` — a real install, as opposed to `electron .` on a checkout. */
  readonly packaged: boolean;
  /** `apps/desktop` in a checkout; the asar root in a packaged app (unused there). */
  readonly desktopRoot: string;
  /** `process.resourcesPath` — meaningless unless `packaged`. */
  readonly resourcesPath: string;
  /** `process.platform`; only the tray icon cares (macOS wants a template image). */
  readonly platform: NodeJS.Platform;
}

export interface DesktopArtifacts {
  /**
   * The server's entry inside the deployed runtime tree. `pnpm deploy` roots
   * the *package* at the target directory, so this is `server-runtime/dist/
   * main.js` and not the repo-shaped `apps/server/dist/main.js`.
   */
  readonly serverEntry: string;
  /**
   * The admin CLI inside that same tree — how the app account is provisioned on
   * first run (#301). Same rooting rule as the server entry above.
   */
  readonly adminCli: string;
  /**
   * The first-run chooser's page (#300). It is not built by anything — three
   * static files that ship as they are — which is why it sits beside `src`
   * rather than in `dist`: `tsc` would neither compile nor copy it, and giving
   * this package a bundler for one HTML file would be the wrong trade.
   */
  readonly chooserPage: string;
  /**
   * The remote session's error page (#302), on the same terms as the chooser.
   * These two paths are also the shell's IPC identities — `main.ts` answers the
   * chooser's channels only for the first and the error page's only for the
   * second (see ipc-sender.ts).
   */
  readonly errorPage: string;
  /**
   * The tray icon (#304), which is two pictures because the two platforms want
   * different ones: a macOS menu-bar icon is a *template* — a black stencil the
   * OS tints for light, dark and selected states — while Windows' notification
   * area shows the app's own artwork. Electron picks up the `@2x` file beside
   * the one it is given, so this is the 1x path in both cases.
   *
   * Linux is not a target for this release (planning, 2026-08-05); it falls to
   * the Windows artwork, which is also the right answer for the tray areas that
   * do exist there.
   */
  readonly trayIcon: string;
  /** The built web app — the renderer, served by the embedded server. */
  readonly webDist: string;
  /** Carried through so the missing-artifact message can name a fix that exists. */
  readonly packaged: boolean;
}

/**
 * Every path the shell needs, for whichever of the two layouts this launch is.
 *
 * Packaged, all five live directly under `process.resourcesPath` — one root,
 * because that is what `extraResources` produces and because a relocatable flat
 * layer is what the sealed server-runtime tree was built for (MX3 §1 as-built
 * 3: no symlink leads out of it, so it can be copied anywhere).
 */
export function resolveArtifactPaths(
  location: ArtifactLocation,
): DesktopArtifacts {
  const { packaged, desktopRoot, resourcesPath, platform } = location;
  const root = packaged ? resourcesPath : desktopRoot;
  const serverRuntime = join(root, "server-runtime");
  return {
    serverEntry: join(serverRuntime, "dist", "main.js"),
    adminCli: join(serverRuntime, "dist", "cli", "admin.js"),
    chooserPage: join(root, "chooser", "index.html"),
    errorPage: join(root, "error", "index.html"),
    trayIcon: join(
      root,
      "assets",
      platform === "darwin" ? "trayTemplate.png" : "tray.png",
    ),
    // The one artifact whose two layouts are not the same shape: in a checkout
    // it belongs to `apps/web` and is named `dist` there, and packaging renames
    // it to `web` on the way in so the resources layer reads as a list of
    // things rather than a list of `dist`s.
    webDist: packaged
      ? join(resourcesPath, "web")
      : resolve(desktopRoot, "..", "web", "dist"),
    packaged,
  };
}

export class MissingArtifactError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MissingArtifactError";
  }
}

/**
 * The two artifacts local mode cannot start without, or an error that names a
 * fix the person reading it can actually carry out — which is a different
 * sentence in each layout: a checkout is missing a build step, and a packaged
 * app is missing part of itself.
 */
export function assertArtifactsPresent(artifacts: DesktopArtifacts): void {
  const missing =
    !existsSync(artifacts.serverEntry) || !existsSync(artifacts.adminCli)
      ? { what: "the embedded server", where: artifacts.serverEntry }
      : !existsSync(join(artifacts.webDist, "index.html"))
        ? { what: "the web app", where: artifacts.webDist }
        : undefined;
  if (missing === undefined) {
    return;
  }
  if (artifacts.packaged) {
    throw new MissingArtifactError(
      [
        `This installation is incomplete — ${missing.what} is not where it should be:`,
        "",
        `  ${missing.where}`,
        "",
        "Reinstalling should restore it.",
      ].join("\n"),
    );
  }
  throw new MissingArtifactError(
    [
      `${missing.what} has not been built yet (${missing.where} is missing).`,
      "",
      `Build it with:  ${
        missing.what === "the embedded server"
          ? "pnpm --filter @emberchat/desktop server-runtime"
          : "pnpm --filter @emberchat/web build"
      }`,
    ].join("\n"),
  );
}
