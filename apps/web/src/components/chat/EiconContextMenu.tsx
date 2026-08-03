// EiconContextMenu: right-click on any rendered eicon — in the log, in the
// composer preview, in the picker — to favourite it, block it, or copy its
// name. Same grammar as the channel/member menus (#234): fixed popover over
// a click-away overlay, measured re-clamp, Escape closes, arrows walk the
// items. Mounted once at the AppShell; the open menu lives in the store.

import {
  useEffect,
  useLayoutEffect,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { PREFS_DEFAULTS } from "@emberchat/protocol";
import { patchPrefs } from "../prefs/patch.js";
import { useEscapeToClose } from "../../lib/useEscapeToClose.js";
import { placeAtPointInWindow } from "../profile/popover.js";
import { prefsIdentityId, useSessionsStore } from "../../stores/sessions.js";
import { useUiStore } from "../../stores/ui.js";
import { useEiconMenuStore } from "../../stores/eicon-menu.js";
import {
  EICON_BLOCKED_CAP,
  hasEicon,
  toggleEiconFavorite,
  withEicon,
  withoutEicon,
} from "./eicon-lists.js";
import styles from "./chat.module.css";

export function EiconContextMenu() {
  const menu = useEiconMenuStore((s) => s.menu);
  if (menu === undefined) {
    return null;
  }
  // Keyed so re-opening on another eicon remounts (fresh focus + clamp).
  return <EiconMenu key={menu.name} name={menu.name} point={menu.point} />;
}

function EiconMenu({
  name,
  point,
}: {
  name: string;
  point: { x: number; y: number };
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const activeIdentityId = useUiStore((s) => s.activeIdentityId);
  const identityId = prefsIdentityId(activeIdentityId);
  const prefs = useSessionsStore((s) =>
    identityId === undefined
      ? PREFS_DEFAULTS
      : (s.sessions[identityId]?.prefs ?? PREFS_DEFAULTS),
  );
  const close = useEiconMenuStore((s) => s.close);

  const favorite = hasEicon(prefs.eiconFavorites, name);
  const blocked = hasEicon(prefs.eiconBlocked, name);

  useLayoutEffect(() => {
    const element = menuRef.current;
    if (!element) {
      return;
    }
    const { top, left } = placeAtPointInWindow(point, {
      width: element.offsetWidth,
      height: element.offsetHeight,
    });
    element.style.left = `${String(left)}px`;
    element.style.top = `${String(top)}px`;
  }, [point]);

  useEscapeToClose(close);

  useEffect(() => {
    enabledItems(menuRef.current)[0]?.focus();
  }, []);

  function onMenuKeyDown(event: ReactKeyboardEvent) {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") {
      return;
    }
    event.preventDefault();
    const items = enabledItems(menuRef.current);
    if (items.length === 0) {
      return;
    }
    const current = items.indexOf(document.activeElement as HTMLElement);
    const next =
      event.key === "ArrowDown"
        ? (current + 1) % items.length
        : (current - 1 + items.length) % items.length;
    items[next]?.focus();
  }

  function toggleFavorite() {
    close();
    if (identityId === undefined) {
      return;
    }
    void patchPrefs(identityId, {
      eiconFavorites: toggleEiconFavorite(prefs.eiconFavorites, name),
    });
  }

  function toggleBlocked() {
    close();
    if (identityId === undefined) {
      return;
    }
    // Refuse at the cap rather than dropping the oldest (the mute-list
    // pattern): silently evicting a block would put an image the user asked
    // never to see back on screen.
    if (!blocked && prefs.eiconBlocked.length >= EICON_BLOCKED_CAP) {
      useSessionsStore
        .getState()
        .applyNotice(
          identityId,
          "error",
          `Blocked-eicon limit reached (${String(EICON_BLOCKED_CAP)}) — remove some in Preferences → Appearance first.`,
        );
      return;
    }
    void patchPrefs(identityId, {
      eiconBlocked: blocked
        ? withoutEicon(prefs.eiconBlocked, name)
        : withEicon(prefs.eiconBlocked, name),
    });
  }

  function copyName() {
    close();
    // Clipboard access can be denied (insecure context, permission); the name
    // is visible in the menu head either way, so failing is not worth a notice.
    void navigator.clipboard?.writeText(name).catch(() => undefined);
  }

  return (
    <>
      <div
        className={styles.memberMenuOverlay}
        onClick={close}
        onContextMenu={(event) => {
          event.preventDefault();
          close();
        }}
      />
      <div
        ref={menuRef}
        className={styles.memberMenu}
        data-eb-surface
        role="menu"
        aria-label={`${name} eicon menu`}
        style={{ left: point.x, top: point.y }}
        onKeyDown={onMenuKeyDown}
      >
        <div className={styles.memberMenuHead}>
          <span className={styles.memberMenuGlyph} aria-hidden>
            ☺
          </span>
          <span className={styles.memberMenuNick}>{name}</span>
        </div>
        <button
          className={styles.memberMenuItem}
          role="menuitem"
          disabled={identityId === undefined}
          title={
            favorite
              ? "Drop it from the picker's Favorites tab"
              : "Keep it one click away in the picker's Favorites tab"
          }
          onClick={toggleFavorite}
        >
          {favorite ? "Unfavourite" : "Favourite"}
        </button>
        <button
          className={styles.memberMenuItem}
          role="menuitem"
          disabled={identityId === undefined}
          title={
            blocked
              ? "Show this eicon's image again"
              : "Never show this eicon's image — messages using it show its name instead"
          }
          onClick={toggleBlocked}
        >
          {blocked ? "Unblock" : "Block"}
        </button>
        <div className={styles.memberMenuDivider} />
        <button
          className={styles.memberMenuItem}
          role="menuitem"
          title="Copy the eicon's name to the clipboard"
          onClick={copyName}
        >
          Copy name
        </button>
      </div>
    </>
  );
}

function enabledItems(root: HTMLDivElement | null): HTMLElement[] {
  return root
    ? [
        ...root.querySelectorAll<HTMLElement>(
          '[role="menuitem"]:not(:disabled)',
        ),
      ]
    : [];
}
