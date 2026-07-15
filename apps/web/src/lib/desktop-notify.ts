// Desktop notifications (M5 step 8, decisions.md §10): mention/PM alerts,
// sender + preview by default with the hide-content privacy pref. All
// best-effort — no Notification API, no permission, or a focused window
// (the badges are on screen) all mean silence, never an error.

/** Strip BBCode tags for the one-line preview. Not a renderer — the tag
 * grammar is `[name]`/`[name=arg]`/`[/name]`, so a bracket strip is exact
 * for well-formed wire content and merely cosmetic for anything else. */
export function previewText(bbcode: string, maxLength = 120): string {
  const text = bbcode.replace(/\[[^\]]*\]/g, "").trim();
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

export function notificationsSupported(): boolean {
  return typeof Notification !== "undefined";
}

/**
 * The pane's opt-in flow: ask the browser when the user flips a toggle on.
 * "denied" is sticky browser state — the pane surfaces it instead of
 * silently persisting a pref that can never fire.
 */
export async function ensureNotifyPermission(): Promise<
  "granted" | "denied" | "unsupported"
> {
  if (!notificationsSupported()) {
    return "unsupported";
  }
  if (Notification.permission === "granted") {
    return "granted";
  }
  if (Notification.permission === "denied") {
    return "denied";
  }
  try {
    return (await Notification.requestPermission()) === "granted"
      ? "granted"
      : "denied";
  } catch {
    return "denied";
  }
}

/**
 * Fire-and-forget message notification. Tagged per conversation so a busy
 * channel coalesces into one notification instead of a stack. Clicking it
 * focuses the tab — navigation stays the user's move.
 */
export function showMessageNotification(options: {
  title: string;
  body?: string;
  /** Coalescing key — the conversation id. */
  tag: string;
}): void {
  if (!notificationsSupported() || Notification.permission !== "granted") {
    return;
  }
  if (document.hasFocus()) {
    return; // the app is on screen — badges and tint are enough
  }
  try {
    const notification = new Notification(options.title, {
      ...(options.body !== undefined ? { body: options.body } : {}),
      tag: options.tag,
    });
    notification.onclick = () => {
      window.focus();
      notification.close();
    };
  } catch {
    // Some platforms throw from the constructor (e.g. Android Chrome
    // requires a ServiceWorker) — a lost notification is never an error.
  }
}
