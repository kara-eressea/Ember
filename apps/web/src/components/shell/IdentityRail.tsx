// IdentityRail (COMPONENTS.md §1): far-left switch between the user's
// identities. Click = route change = the entire session context swaps from
// that identity's store slice. Background identities carry unread/mention
// badges; the active one never does. Right-click opens the identity menu:
// set status / connect–log off / move up–down (persisted rail order).

import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent,
} from "react";
import { Link } from "react-router";
import {
  CLIENT_SETTABLE_STATUSES,
  type ClientSettableStatus,
} from "@emberchat/protocol";
import { gateway } from "../../gateway/socket.js";
import { api } from "../../lib/api.js";
import { presenceDot } from "../../lib/presence.js";
import { identityPath } from "../../lib/routes.js";
import {
  useSessionsStore,
  type IdentitySummary,
} from "../../stores/sessions.js";
import { useUiStore } from "../../stores/ui.js";
import { Avatar } from "../common/Avatar.js";
import { railBadge, railDot } from "./rail-data.js";
import styles from "./shell.module.css";

const DOT_CLASS: Record<string, string | undefined> = {
  ok: styles.dotOk,
  warn: styles.dotWarn,
  faint: styles.dotFaint,
};

interface MenuState {
  identityId: string;
  x: number;
  y: number;
}

export function IdentityRail({ activeId }: { activeId: string }) {
  const identities = useSessionsStore((s) => s.identities);
  const [menu, setMenu] = useState<MenuState>();

  if (identities === undefined) {
    return <nav className={styles.rail} aria-label="Identities" />;
  }
  const menuIdentity = identities.find((i) => i.id === menu?.identityId);
  return (
    <nav className={styles.rail} aria-label="Identities">
      {identities.map((identity) => (
        <RailItem
          key={identity.id}
          identity={identity}
          active={identity.id === activeId}
          onMenu={(event) => {
            event.preventDefault();
            // Keyboard-invoked (Menu key / Shift+F10) contextmenu events
            // carry 0,0 coordinates — anchor to the item instead of the
            // viewport corner.
            const keyboard = event.clientX === 0 && event.clientY === 0;
            const rect = event.currentTarget.getBoundingClientRect();
            setMenu({
              identityId: identity.id,
              x: keyboard ? rect.right : event.clientX,
              y: keyboard ? rect.top : event.clientY,
            });
          }}
        />
      ))}
      <Link
        className={styles.railAdd}
        to="/identities"
        title="Add or manage identities"
        aria-label="Add or manage identities"
      >
        +
      </Link>
      {menu && menuIdentity && (
        <RailMenu
          identity={menuIdentity}
          identities={identities}
          position={menu}
          onClose={() => {
            setMenu(undefined);
          }}
        />
      )}
    </nav>
  );
}

function RailItem({
  identity,
  active,
  onMenu,
}: {
  identity: IdentitySummary;
  active: boolean;
  onMenu: (event: MouseEvent) => void;
}) {
  const slice = useSessionsStore((s) => s.sessions[identity.id]);
  const lastConv = useUiStore((s) => s.lastConvByIdentity[identity.id]);
  const badge = railBadge(identity, slice);
  const dot = railDot(
    slice?.sessionStatus ?? "offline",
    slice?.ownStatus ?? "online",
  );
  const base = identityPath(identity.name);
  const to = lastConv !== undefined ? `${base}/${lastConv}` : base;
  // The label overrides the link's content for assistive tech, so the badge
  // has to travel inside it — a visual-only badge would be silent.
  const label = active
    ? identity.name
    : badge.mentions > 0
      ? `${identity.name}, ${String(badge.mentions)} mentions, ${String(badge.unread)} unread`
      : badge.unread > 0
        ? `${identity.name}, ${String(badge.unread)} unread`
        : identity.name;

  return (
    <Link
      className={`${styles.railItem} ${active ? (styles.railActive ?? "") : ""}`}
      to={to}
      title={identity.name}
      aria-label={label}
      aria-current={active ? "page" : undefined}
      data-testid="rail-item"
      onContextMenu={onMenu}
    >
      <span className={styles.railAvatar}>
        <Avatar name={identity.name} size={40} square={active} />
        <span className={`${styles.railDot} ${DOT_CLASS[dot] ?? ""}`} />
        {!active && badge.mentions > 0 && (
          <span
            className={`${styles.railBadge} ${styles.railBadgeMention ?? ""}`}
            data-testid="rail-badge"
          >
            @{badge.mentions > 99 ? "99+" : badge.mentions}
          </span>
        )}
        {!active && badge.mentions === 0 && badge.unread > 0 && (
          <span className={styles.railBadge} data-testid="rail-badge">
            {badge.unread > 99 ? "99+" : badge.unread}
          </span>
        )}
      </span>
    </Link>
  );
}

/**
 * The rail context menu (COMPONENTS.md §1 behavior). Reorder is move
 * up/down: the swapped order goes to `PUT /identities/order` and the
 * `identities.reordered` fan-out converges every tab (applied optimistically
 * here so the click feels instant).
 */
function RailMenu({
  identity,
  identities,
  position,
  onClose,
}: {
  identity: IdentitySummary;
  identities: IdentitySummary[];
  position: { x: number; y: number };
  onClose: () => void;
}) {
  const slice = useSessionsStore((s) => s.sessions[identity.id]);
  const online = slice?.sessionStatus === "online";
  const connected =
    slice !== undefined &&
    slice.sessionStatus !== "offline" &&
    slice.sessionStatus !== "stopped";
  const index = identities.findIndex((i) => i.id === identity.id);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onClose();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  // Menus move focus into themselves; arrow keys walk the enabled items.
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
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      event.key === "ArrowDown"
        ? (current + 1) % items.length
        : (current - 1 + items.length) % items.length;
    items[next]?.focus();
  }

  function setStatus(status: ClientSettableStatus) {
    void gateway
      .cmd({
        identityId: identity.id,
        action: "status.set",
        // Keep the message — the menu only switches the status itself.
        d: { status, statusmsg: slice?.ownStatusmsg ?? "" },
      })
      .then((ack) => {
        if (!ack.ok) {
          useSessionsStore
            .getState()
            .applyNotice(
              identity.id,
              "error",
              ack.error ?? "Could not set status",
            );
        }
      });
    onClose();
  }

  function togglePower() {
    const action = connected ? "session.disconnect" : "session.connect";
    void gateway.cmd({ identityId: identity.id, action }).then((ack) => {
      if (ack.ok) {
        useSessionsStore.getState().setAutoConnect(identity.id, !connected);
      } else {
        useSessionsStore
          .getState()
          .applyNotice(
            identity.id,
            "error",
            ack.error ??
              (connected ? "Could not log off" : "Could not connect"),
          );
      }
    });
    onClose();
  }

  function move(delta: -1 | 1) {
    const target = index + delta;
    if (index === -1 || target < 0 || target >= identities.length) {
      return;
    }
    const previous = identities.map((i) => i.id);
    const order = [...previous];
    [order[index], order[target]] = [order[target]!, order[index]!];
    useSessionsStore.getState().applyIdentityOrder(order);
    void api.reorderIdentities(order).catch(() => {
      // A stale list (create/delete raced us). Revert — `ready` only comes
      // with a socket reconnect, so an optimistic order left standing would
      // diverge from the server and every other tab indefinitely.
      useSessionsStore.getState().applyIdentityOrder(previous);
      useSessionsStore
        .getState()
        .applyNotice(
          identity.id,
          "error",
          "Could not reorder — the identity list changed; try again",
        );
    });
    onClose();
  }

  return (
    <>
      <div
        className={styles.railMenuOverlay}
        onClick={onClose}
        onContextMenu={(event) => {
          event.preventDefault();
          onClose();
        }}
      />
      <div
        ref={menuRef}
        className={styles.railMenu}
        role="menu"
        aria-label={`${identity.name} menu`}
        style={{ left: position.x, top: position.y }}
        onKeyDown={onMenuKeyDown}
      >
        <div className={styles.railMenuName}>{identity.name}</div>
        <div className={styles.railMenuSection}>Status</div>
        {CLIENT_SETTABLE_STATUSES.map((status) => (
          <button
            key={status}
            className={styles.railMenuItem}
            role="menuitem"
            disabled={!online}
            onClick={() => {
              setStatus(status);
            }}
          >
            <span
              className={`${styles.navDot} ${DOT_CLASS[presenceDot(true, status)] ?? ""}`}
            />
            {status}
            {online && slice.ownStatus === status ? " ✓" : ""}
          </button>
        ))}
        <div className={styles.railMenuSection}>Session</div>
        <button
          className={styles.railMenuItem}
          role="menuitem"
          onClick={togglePower}
        >
          ⏻ {connected ? "Log off" : "Connect"}
        </button>
        <div className={styles.railMenuSection}>Order</div>
        <button
          className={styles.railMenuItem}
          role="menuitem"
          disabled={index <= 0}
          onClick={() => {
            move(-1);
          }}
        >
          ↑ Move up
        </button>
        <button
          className={styles.railMenuItem}
          role="menuitem"
          disabled={index === -1 || index >= identities.length - 1}
          onClick={() => {
            move(1);
          }}
        >
          ↓ Move down
        </button>
      </div>
    </>
  );
}

function enabledItems(root: HTMLDivElement | null): HTMLButtonElement[] {
  return root
    ? [
        ...root.querySelectorAll<HTMLButtonElement>(
          'button[role="menuitem"]:not(:disabled)',
        ),
      ]
    : [];
}
