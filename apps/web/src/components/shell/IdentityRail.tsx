// IdentityRail (COMPONENTS.md §1): far-left switch between the user's
// identities. Click = route change = the entire session context swaps from
// that identity's store slice. Background identities carry unread/mention
// badges; the active one never does. The right-click menu (status /
// reconnect / disconnect / reorder) arrives in M3 step 4.

import { Link } from "react-router";
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

export function IdentityRail({ activeId }: { activeId: string }) {
  const identities = useSessionsStore((s) => s.identities);
  if (identities === undefined) {
    return <nav className={styles.rail} aria-label="Identities" />;
  }
  return (
    <nav className={styles.rail} aria-label="Identities">
      {identities.map((identity) => (
        <RailItem
          key={identity.id}
          identity={identity}
          active={identity.id === activeId}
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
    </nav>
  );
}

function RailItem({
  identity,
  active,
}: {
  identity: IdentitySummary;
  active: boolean;
}) {
  const slice = useSessionsStore((s) => s.sessions[identity.id]);
  const lastConv = useUiStore((s) => s.lastConvByIdentity[identity.id]);
  const badge = railBadge(identity, slice);
  const dot = railDot(
    slice?.sessionStatus ?? "offline",
    slice?.ownStatus ?? "online",
  );
  const to =
    lastConv !== undefined
      ? `/app/${identity.id}/${lastConv}`
      : `/app/${identity.id}`;

  return (
    <Link
      className={`${styles.railItem} ${active ? (styles.railActive ?? "") : ""}`}
      to={to}
      title={identity.name}
      aria-label={identity.name}
      aria-current={active ? "page" : undefined}
      data-testid="rail-item"
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
