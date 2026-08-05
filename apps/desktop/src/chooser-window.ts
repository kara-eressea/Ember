import { BrowserWindow, shell } from "electron";
import { fileURLToPath } from "node:url";
import { isExternalWebUrl } from "./navigation.js";

/**
 * The first-run chooser window (mx3-desktop-shell.md §4) — the one piece of UI
 * this package owns, and the documented exception to "no renderer code here"
 * (invariant 2). It shows a static `file://` page from `apps/desktop/chooser/`:
 * no framework, no bundler, no build step beyond the preload's `tsc`.
 *
 * Fixed size, because it has exactly one screen's worth of content and a
 * resizable window would only ever be resized wrong. Not shown until it has
 * painted, like the app window.
 */

const PRELOAD = fileURLToPath(new URL("chooser-preload.cjs", import.meta.url));

/** Matches the page's `--bg` token (slate `bg`) so there is no white flash. */
const BACKGROUND = "#1b1917";

/**
 * Content size, not frame size: the page is what has to fit, and a title bar
 * is a different height on every platform. At 560 wide the page measures 568
 * at rest and 643 with the longest refusal message wrapped to two lines, so
 * the height is the worst case rather than the resting one — a fixed window
 * that cuts off the sentence explaining why it refused would be the one thing
 * this window must not do. (The page scrolls as a last resort; nothing here
 * can be permanently out of reach.)
 */
const WIDTH = 560;
const HEIGHT = 656;

export interface ChooserWindowOptions {
  /** Absolute path to `chooser/index.html` (see paths.ts). */
  readonly page: string;
  /** `app.getName()` — the product name is config, never a literal (CLAUDE.md). */
  readonly productName: string;
  /** Prefill for the URL field when an existing thin-client config is being changed. */
  readonly serverUrl?: string;
}

export function createChooserWindow(
  options: ChooserWindowOptions,
): BrowserWindow {
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

  // The page's two variable strings arrive as query parameters rather than
  // over the bridge: they are needed while the document is still being built,
  // and neither is a secret. It also keeps the bridge at exactly the two calls
  // the spec asks for.
  const query: Record<string, string> = { product: options.productName };
  if (options.serverUrl !== undefined) {
    query.url = options.serverUrl;
  }
  void window.loadFile(options.page, { query });

  // Same policy as the app window: nothing navigates this frame anywhere, and
  // a link (there is one — the honest description of thin-client mode has
  // none, but a future revision might) opens in the user's own browser.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isExternalWebUrl("about:blank", url)) {
      void shell.openExternal(url);
    }
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event) => {
    event.preventDefault();
  });

  return window;
}
