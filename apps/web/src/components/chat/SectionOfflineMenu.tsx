// SectionOfflineMenu (#329): right-click menu on a sidebar people-section
// header — Friends, Bookmarks, or Direct messages — with a single "Show
// offline" checkbox that toggles that section's synced pref. Same popover
// grammar as the channel-row menu (#234): a fixed popover over a click-away
// overlay, measured re-clamp pre-paint, Escape closes, arrows walk the items.

import { useEffect, useLayoutEffect, useRef } from "react";
import { PREFS_DEFAULTS } from "@emberchat/protocol";
import { useEscapeToClose } from "../../lib/useEscapeToClose.js";
import { useSessionsStore } from "../../stores/sessions.js";
import {
  SHOW_OFFLINE_PREF,
  type OfflineSection,
} from "../shell/offline-filter.js";
import { patchPrefs } from "../prefs/patch.js";
import styles from "./chat.module.css";

/** Plain-language section names for the menu heading. */
const SECTION_LABEL: Record<OfflineSection, string> = {
  friends: "Friends",
  bookmarks: "Bookmarks",
  dms: "Direct messages",
};

export function SectionOfflineMenu({
  identityId,
  section,
  position,
  onClose,
}: {
  identityId: string;
  section: OfflineSection;
  position: { x: number; y: number };
  onClose: () => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const prefs = useSessionsStore(
    (s) => s.sessions[identityId]?.prefs ?? PREFS_DEFAULTS,
  );
  const prefKey = SHOW_OFFLINE_PREF[section];
  const showOffline = prefs[prefKey];

  // Clamp against the measured menu, DOM write pre-paint (cf. the channel
  // and identity menus).
  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!el) {
      return;
    }
    const margin = 8;
    const rect = el.getBoundingClientRect();
    const left = Math.min(position.x, window.innerWidth - rect.width - margin);
    const top = Math.min(position.y, window.innerHeight - rect.height - margin);
    el.style.left = `${String(Math.max(margin, left))}px`;
    el.style.top = `${String(Math.max(margin, top))}px`;
  }, [position]);

  useEscapeToClose(onClose);

  // Menus move focus into themselves so the toggle is reachable by keyboard.
  useEffect(() => {
    menuRef.current
      ?.querySelector<HTMLElement>('[role="menuitemcheckbox"]')
      ?.focus();
  }, []);

  function toggle() {
    onClose();
    void patchPrefs(identityId, { [prefKey]: !showOffline });
  }

  return (
    <>
      <div
        className={styles.memberMenuOverlay}
        onClick={onClose}
        onContextMenu={(event) => {
          event.preventDefault();
          onClose();
        }}
      />
      <div
        ref={menuRef}
        className={styles.memberMenu}
        role="menu"
        aria-label={`${SECTION_LABEL[section]} section menu`}
        style={{ left: position.x, top: position.y }}
      >
        <div className={styles.memberMenuHead}>
          <span className={styles.memberMenuNick}>
            {SECTION_LABEL[section]}
          </span>
        </div>
        <button
          className={styles.memberMenuItem}
          role="menuitemcheckbox"
          aria-checked={showOffline}
          title={
            showOffline
              ? "Hide offline people in this section (pinned, unread, and open chats still show)"
              : "Show offline people in this section too"
          }
          onClick={toggle}
        >
          Show offline
          {showOffline && (
            <span className={styles.memberMenuCheck} aria-hidden>
              ✓
            </span>
          )}
        </button>
      </div>
    </>
  );
}
