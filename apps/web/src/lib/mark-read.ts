// Mark a conversation read from outside the message view (#315): the sidebar
// "Mark as read" context-menu items call this. It reuses the exact same two
// steps the message log runs on Esc / jump-to-recent (#254) — clear the local
// badges for instant feedback, then advance the persisted per-account read
// cursor to the newest message so the change fans out and sticks across
// devices and reattaches. It never navigates to the conversation.

import { gateway } from "../gateway/socket.js";
import { useSessionsStore } from "../stores/sessions.js";

export function markConversationRead(identityId: string, convId: string): void {
  // Instant local feedback; the fan-out below converges every other tab.
  useSessionsStore.getState().clearUnread(identityId, convId);
  // Persist the cursor to the newest message. The message id may not be loaded
  // for a conversation we never opened this session, so let the server clamp a
  // sentinel to the true latest (see gateway.markReadToLatest).
  gateway.markReadToLatest(identityId, convId);
}
