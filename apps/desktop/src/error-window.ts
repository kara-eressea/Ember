import { BrowserWindow } from "electron";
import { fileURLToPath } from "node:url";
import { errorPageQuery, type RemoteFailure } from "./error-page.js";

/**
 * The remote session's error window (mx3-desktop-shell.md §5) — the shell's
 * answer to "the server this window exists to show did not load".
 *
 * A window of its own rather than the app window with a different document,
 * for two reasons that both come from #299's navigation policy: that window is
 * allowed to be at the app origin and nowhere else (`window.ts`), and loading a
 * `file://` page into it would mean putting a hole in exactly the rule that
 * keeps somebody else's origin from wandering. And this page needs a bridge —
 * Retry, Switch mode — which the app window's preload deliberately does not
 * have. Two windows, two preloads, two vocabularies, no overlap.
 *
 * Everything else follows the chooser: a static `file://` document with a
 * strict CSP, fixed size, shown when painted, its variable strings arriving as
 * query parameters.
 */

const PRELOAD = fileURLToPath(new URL("error-preload.cjs", import.meta.url));

/** Matches the page's `--bg` token (slate `bg`) so there is no white flash. */
const BACKGROUND = "#1b1917";

/**
 * Content size, not frame size. Narrower and shorter than the chooser: this
 * page is a headline, two facts and two buttons, and the one thing that grows
 * — the detail sentence — is the reason the height has room to spare. The page
 * scrolls as a last resort (error.css), so nothing can be permanently clipped.
 */
const WIDTH = 520;
const HEIGHT = 440;

export interface ErrorWindowOptions {
  /** Absolute path to `error/index.html` (see paths.ts). */
  readonly page: string;
  /** `app.getName()` — the product name is config, never a literal (CLAUDE.md). */
  readonly productName: string;
  /** The address this window was supposed to be showing. */
  readonly serverUrl: string;
  readonly failure: RemoteFailure;
}

export function createErrorWindow(options: ErrorWindowOptions): BrowserWindow {
  const window = new BrowserWindow({
    width: WIDTH,
    height: HEIGHT,
    useContentSize: true,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    title: options.productName,
    show: false,
    backgroundColor: BACKGROUND,
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
    },
  });

  window.once("ready-to-show", () => {
    window.show();
  });

  showErrorPage(window, options);

  // Nothing navigates this frame anywhere, and it has no links to open: a page
  // about an unreachable server has no business reaching one. (The chooser
  // keeps a `setWindowOpenHandler` for a link it might grow; this one refuses
  // both outright, which is the same policy with one fewer door.)
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => {
    event.preventDefault();
  });

  return window;
}

/**
 * (Re)state a failure in an open error window.
 *
 * A second failure while this window is already up — the server came back and
 * went away again, or came back with an expired certificate — reloads the same
 * document with new parameters rather than opening a second window. The page
 * also updates itself in place from a Retry's answer (`error.js`); this is the
 * path for failures that arrive from the *window*, which has no such answer to
 * carry them.
 */
export function showErrorPage(
  window: BrowserWindow,
  options: ErrorWindowOptions,
): void {
  void window.loadFile(options.page, {
    query: errorPageQuery({
      productName: options.productName,
      serverUrl: options.serverUrl,
      failure: options.failure,
    }),
  });
}
