/**
 * The tray, and what a closing window means (mx3-desktop-shell.md §6).
 *
 * Everything here is a pure function over plain values, for the same reason the
 * rest of this package's decisions are: a `Tray`, a hidden window and a dock
 * icon cannot be exercised headlessly, so the parts that can be — the close
 * table, the menu's shape, the words — are kept where a test can reach them.
 * `tray.ts` builds the real tray from `trayMenuModel`, and `main.ts` carries
 * the two verdicts out.
 *
 * The rule the whole file exists to state: **in local mode, closing the window
 * does not stop the bouncer.** That is the product — sessions stay online with
 * the window shut, exactly as they do for the self-hoster whose server this
 * process is standing in for (decision of 2026-07-22). In thin-client mode
 * there is no local bouncer to keep alive, so close means quit, and a tray
 * would be theatre.
 */

/** Which of the shell's windows is closing. */
export type ShellWindow =
  /** The web app itself — the only one that ever hides (§6). */
  | "app"
  /** The first-run/switch-mode chooser (§4). */
  | "chooser"
  /** The remote session's failure page (§5), thin-client only. */
  | "error";

/** What this launch became — `planStartup`'s answer, remembered. */
export type LifecycleMode = "local" | "thin-client" | "choose";

export interface CloseContext {
  readonly mode: LifecycleMode;
  /**
   * Whether a tray with a way back into the app actually exists. Not implied
   * by the mode: local mode creates one as it starts, and the window can be
   * closed in the gap — a hidden window with nothing to reopen it would be an
   * app the user cannot get back to and cannot quit.
   */
  readonly trayPresent: boolean;
  /**
   * A quit or a mode-switch relaunch is already underway. Everything closes on
   * the way out; nothing hides.
   */
  readonly quitting: boolean;
}

/** Whether the app outlives its windows right now — the one predicate. */
function staysAlive(context: CloseContext): boolean {
  return context.mode === "local" && context.trayPresent && !context.quitting;
}

/**
 * What to do when a window is asked to close.
 *
 * Only the app window in local mode hides, and only while there is a tray to
 * bring it back. The chooser closing means the question was declined (§4) and
 * the error window closing means the user is done with a remote session that
 * would not load (§5) — both of those are the app being dismissed, and the
 * mode they happen in does not change that.
 */
export function decideWindowClose(
  window: ShellWindow,
  context: CloseContext,
): "hide-to-tray" | "close" {
  return window === "app" && staysAlive(context) ? "hide-to-tray" : "close";
}

/**
 * What `window-all-closed` means now.
 *
 * Before the tray, it always meant quit. It still does everywhere except local
 * mode with a tray up: there the bouncer is the point of the process, the tray
 * is the way back in, and no window on screen is a normal state rather than
 * the end of the app. (In practice a hidden window is still a window, so the
 * event rarely fires in that mode at all — but "rarely" is not a lifecycle
 * rule, and the one path that gets there for real is a window destroyed rather
 * than closed.)
 */
export function decideLastWindowClosed(context: CloseContext): "stay" | "quit" {
  return staysAlive(context) ? "stay" : "quit";
}

/** What the shell knows about the bouncer without asking it anything new. */
export type TrayStatus =
  /** Starting up: provisioning, migrating, or waiting for the first /healthz. */
  | "connecting"
  /** The child answered /healthz and has not exited since. */
  | "running";

export type TrayCommand = "open" | "quit";

export type TrayMenuItem =
  /** A line to read, not to click — the app's name, and how it is doing. */
  | { readonly kind: "info"; readonly label: string }
  | { readonly kind: "separator" }
  | {
      readonly kind: "command";
      readonly id: TrayCommand;
      readonly label: string;
    };

export interface TrayMenuModel {
  readonly tooltip: string;
  readonly items: readonly TrayMenuItem[];
}

/**
 * The status line, in the tray's own words.
 *
 * Deliberately about the bouncer and not about F-Chat: this process knows that
 * its server child is alive and answered `/healthz` once, and nothing else
 * without asking — and §6 asks for no live poller. Claiming "connected" for
 * every identity would be a promise made out of a fact the shell does not have.
 */
export function trayStatusLine(status: TrayStatus): string {
  return status === "running"
    ? "Running — you stay online with the window closed"
    : "Starting up…";
}

export function trayTooltip(productName: string, status: TrayStatus): string {
  return `${productName} — ${status === "running" ? "running" : "starting up"}`;
}

/**
 * The whole menu, as data. Two lines that say what this is and how it is
 * doing, then the only two things a tray icon owes anybody: a way back in, and
 * a way out (§6).
 */
export function trayMenuModel(options: {
  readonly productName: string;
  readonly status: TrayStatus;
}): TrayMenuModel {
  const { productName, status } = options;
  return {
    tooltip: trayTooltip(productName, status),
    items: [
      { kind: "info", label: productName },
      { kind: "info", label: trayStatusLine(status) },
      { kind: "separator" },
      { kind: "command", id: "open", label: `Open ${productName}` },
      { kind: "separator" },
      // The honest half of the deal: this is the path that disconnects.
      { kind: "command", id: "quit", label: `Quit ${productName}` },
    ],
  };
}

/**
 * The one-time notice (§6) — said once, the first time a window vanishes into
 * the tray, because a chat client that closes without going offline is not
 * what the user's other apps have taught them to expect. Saying it every time
 * would be nagging; never saying it would be a surprise.
 */
export function trayNoticeMessage(productName: string): {
  readonly title: string;
  readonly body: string;
} {
  return {
    title: "Still running in the tray",
    body: `${productName} keeps your characters online while the window is closed. Quit from the tray when you want to go offline.`,
  };
}
