// Preferences window (COMPONENTS.md §12): 748×560 modal, rail + pane.
// Opened from the MeBar gear. Pane contents land with their milestone
// steps (M5 4–8); until then each pane is an honest stub. Everything a
// pane persists goes through the gateway `prefs.set` patch — per app
// account, synced across every device (decisions.md §10).

import { useEffect, useRef, useState } from "react";
import { AppearancePane } from "./AppearancePane.js";
import { AwayLogsPane } from "./AwayLogsPane.js";
import { GeneralPane } from "./GeneralPane.js";
import { HighlightsPane } from "./HighlightsPane.js";
import { NotificationsPane } from "./NotificationsPane.js";
import styles from "./prefs.module.css";

const PANES = [
  { id: "general", label: "General", glyph: "⚙" },
  { id: "appearance", label: "Appearance", glyph: "◐" },
  { id: "highlights", label: "Highlights", glyph: "@" },
  { id: "away", label: "Away & logs", glyph: "☾" },
  { id: "notifications", label: "Notifications", glyph: "◉" },
  { id: "network", label: "Network", glyph: "⇄" },
] as const;

type PaneId = (typeof PANES)[number]["id"];

export function PreferencesWindow({
  identityId,
  onClose,
}: {
  /** Routes prefs.set acks; prefs themselves are per app account. */
  identityId: string;
  onClose: () => void;
}) {
  const [pane, setPane] = useState<PaneId>("general");
  const windowRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    windowRef.current?.focus();
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

  const active = PANES.find((entry) => entry.id === pane) ?? PANES[0];

  return (
    <div
      className={styles.overlay}
      onPointerDown={(event) => {
        // Backdrop only — clicks inside the window must not close it.
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div
        className={styles.window}
        role="dialog"
        aria-modal="true"
        aria-label="Preferences"
        tabIndex={-1}
        ref={windowRef}
      >
        <nav className={styles.rail} aria-label="Preference sections">
          <div className={styles.railTitle}>Preferences</div>
          {PANES.map((entry) => (
            <button
              key={entry.id}
              type="button"
              className={`${styles.railItem} ${
                entry.id === pane ? styles.railItemActive : ""
              }`}
              aria-current={entry.id === pane ? "page" : undefined}
              onClick={() => {
                setPane(entry.id);
              }}
            >
              <span className={styles.railGlyph} aria-hidden>
                {entry.glyph}
              </span>
              {entry.label}
            </button>
          ))}
          <div className={styles.railFoot}>
            Account &amp; profile live on the server website ↗
          </div>
        </nav>
        <section className={styles.pane}>
          <header className={styles.paneHead}>
            <h2 className={styles.paneTitle}>{active.label}</h2>
            <button
              type="button"
              className={styles.close}
              aria-label="Close preferences"
              onClick={onClose}
            >
              ✕
            </button>
          </header>
          <div className={styles.paneBody}>
            <PaneContent
              pane={pane}
              identityId={identityId}
              onClose={onClose}
            />
          </div>
        </section>
      </div>
    </div>
  );
}

function PaneContent({
  pane,
  identityId,
  onClose,
}: {
  pane: PaneId;
  identityId: string;
  onClose: () => void;
}) {
  switch (pane) {
    case "general":
      return <GeneralPane identityId={identityId} onClose={onClose} />;
    case "appearance":
      return <AppearancePane identityId={identityId} />;
    case "highlights":
      return <HighlightsPane identityId={identityId} />;
    case "away":
      return <AwayLogsPane identityId={identityId} />;
    case "notifications":
      return <NotificationsPane identityId={identityId} />;
    case "network":
      return (
        <p className={styles.stub}>
          Connection diagnostics arrive with a later milestone.
        </p>
      );
  }
}
