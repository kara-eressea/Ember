// Drives the two out-of-app unread signals (#390) off the same count: the
// favicon badge and the document-title prefix. Both update only when the
// count changes, and agree by construction because they read one value.

import { useEffect } from "react";
import { useSessionsStore } from "../stores/sessions.js";
import { appConfig } from "./config.js";
import { applyFaviconBadge, unreadBadgeCount } from "./favicon-badge.js";

export function useUnreadIndicator(): void {
  const count = useSessionsStore((s) =>
    unreadBadgeCount(s.identities, s.sessions),
  );
  useEffect(() => {
    applyFaviconBadge(count);
    const name = appConfig().appName;
    // The transient title flash (highlight-notify) alternates on top of this;
    // it captures whatever title stands, so the two stay consistent.
    document.title = count > 0 ? `(${String(count)}) ${name}` : name;
  }, [count]);
}
