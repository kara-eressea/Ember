// SectionOfflineMenu (#329): right-click — or long-press on a touchscreen
// (MP2 §1) — menu on a sidebar people-section header (Friends, Bookmarks, or
// Direct messages) with a single "Show offline" checkbox that toggles that
// section's synced pref. Same grammar as the channel-row menu (#234), in the
// shell they share: an anchored popover on a desktop, a bottom sheet on a
// phone (MenuSurface).

import { useEffect, useRef } from "react";
import { PREFS_DEFAULTS } from "@emberchat/protocol";
import { MenuSurface } from "../common/MenuSurface.js";
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
    <MenuSurface
      className={styles.memberMenu}
      overlayClassName={styles.memberMenuOverlay}
      label={`${SECTION_LABEL[section]} section menu`}
      point={position}
      onClose={onClose}
      menuRef={menuRef}
      head={
        <div className={styles.memberMenuHead}>
          <span className={styles.memberMenuNick}>
            {SECTION_LABEL[section]}
          </span>
        </div>
      }
    >
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
    </MenuSurface>
  );
}
