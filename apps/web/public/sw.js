/*
 * Push-only service worker (design/web-push.md §4, invariant 1).
 *
 * This file is the single exception to MP3's no-service-worker decision, and
 * the exception is narrow on purpose: a browser cannot display a Web Push
 * notification without a worker registered, so this one exists to display them
 * and to route the click that follows. It handles no `fetch` and touches no
 * cache — the reasoning MP3 wrote down still holds in full (the client is a
 * live view onto a bouncer, and a cache that answers first would serve a
 * conversation that has moved on). That absence is enforced by
 * `src/shipping-shape.test.ts`, not by good intentions: a worker outlives the
 * deployment that installed it, so a caching handler added here by accident is
 * a bug that cannot be fixed by shipping a fix.
 *
 * Plain JS, no bundling: Vite copies `public/` to the dist root verbatim, so
 * what is written here is exactly what claims the origin's root scope.
 *
 * It is also registered only for users who opted in (`src/lib/push.ts`,
 * invariant 2) — nobody else's browser ever sees it.
 */

const ICON = "/icons/icon-192.png";

/** The subject line for one payload kind, phrased as `dispatch.ts` phrases the
 * same events in the notice strip (`rtbNoticeText`). */
function subjectFor(payload) {
  const who = payload.character || "Someone";
  switch (payload.kind) {
    case "friendrequest":
      return who + " sent a friend request";
    case "note":
      return "New note from " + who;
    case "comment":
      return who + " replied to a comment thread you follow";
    default:
      return who;
  }
}

/**
 * Title, formatted the way `src/lib/desktop-notify.ts` formats its own: a
 * subject, then an em dash and the context. The page-side notification's
 * context is the channel, because that is what a tab knows; here it is the
 * receiving identity, because that is what the payload carries and what a user
 * with several personas needs in order to read a locked phone screen and know
 * which of them was written to.
 */
function titleFor(payload) {
  const subject = subjectFor(payload);
  return payload.identity ? subject + " — " + payload.identity : subject;
}

/**
 * The dedup key, and it must stay identical to the page's
 * (`gateway/dispatch.ts`: the conversation id for messages, `rtb:<type>` for
 * website events). A background tab fires its own notification for the same
 * event this push carries; matching tags collapse the two into one entry
 * instead of stacking them, and `renotify` is left at its default so the
 * second arrival is silent.
 */
function tagFor(payload) {
  return payload.convId ? payload.convId : "rtb:" + payload.kind;
}

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  event.waitUntil(
    (async () => {
      let payload;
      try {
        payload = event.data ? event.data.json() : undefined;
      } catch {
        payload = undefined;
      }
      if (!payload) {
        return;
      }
      // The focused-window case belongs to the page: it already shows the
      // badge and the tint, and fires its own notification when the window is
      // merely unfocused. `includeUncontrolled` because a tab opened before
      // this worker claimed the scope is still a tab the user is looking at.
      const windows = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      if (windows.some((client) => client.focused)) {
        return;
      }
      const options = {
        tag: tagFor(payload),
        icon: ICON,
        data: { url: payload.url },
      };
      if (payload.excerpt) {
        options.body = payload.excerpt;
      }
      await self.registration.showNotification(titleFor(payload), options);
    })(),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      // Reuse a window rather than pile up tabs: the app is a socket-backed
      // shell, and a second copy of it is a second gateway connection.
      const existing = windows[0];
      if (existing) {
        await existing.focus();
        if (existing.navigate) {
          try {
            await existing.navigate(url);
          } catch {
            // `navigate` refuses on clients this worker does not control; the
            // window is focused either way, which is the half that matters.
          }
        }
        return;
      }
      await self.clients.openWindow(url);
    })(),
  );
});
