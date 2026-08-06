// Drives the two out-of-app unread signals (#390) off the same state: the
// favicon badge and the document-title prefix. Both update only when the
// state changes, and agree by construction because they read one value.

import { useEffect } from "react";
import { useShallow } from "zustand/react/shallow";
import { APP_NAME } from "@emberchat/protocol";
import { useSessionsStore } from "../stores/sessions.js";
import { applyFaviconBadge, unreadIndicator } from "./favicon-badge.js";
import { setBaseTitle } from "./highlight-notify.js";

export function useUnreadIndicator(): void {
  const { count, dot } = useSessionsStore(
    useShallow((s) => unreadIndicator(s.identities, s.sessions)),
  );
  useEffect(() => {
    applyFaviconBadge({ count, dot });
    // Only the numeric tier reaches the title: a count of ordinary channel
    // chatter is exactly what the dot tier is for, and a marker with no
    // number in the tab strip is noise next to the icon that already shows
    // it. The transient title flash (highlight-notify) alternates on top.
    setBaseTitle(count > 0 ? `(${String(count)}) ${APP_NAME}` : APP_NAME);
  }, [count, dot]);
}
