// Preferences window (COMPONENTS.md §12): 748×560 modal, rail + pane.
// Opened from the MeBar gear. Pane contents land with their milestone
// steps (M5 4–8); until then each pane is an honest stub. Everything a
// pane persists goes through the gateway `prefs.set` patch — per app
// account, synced across every device (decisions.md §10).

import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
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

export function PreferencesWindow({ onClose }: { onClose: () => void }) {
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
            <PaneContent pane={pane} onClose={onClose} />
          </div>
        </section>
      </div>
    </div>
  );
}

function PaneContent({ pane, onClose }: { pane: PaneId; onClose: () => void }) {
  switch (pane) {
    case "general":
      return (
        <>
          <p className={styles.stub}>
            General settings arrive as the preference panes fill in (M5).
          </p>
          <p className={styles.stub}>
            Identities and F-List accounts are managed on the{" "}
            <Link to="/identities" onClick={onClose}>
              identity screen
            </Link>
            .
          </p>
        </>
      );
    case "appearance":
      return (
        <p className={styles.stub}>
          Accent, base theme, density, timestamps and message layout arrive with
          M5 step 4.
        </p>
      );
    case "highlights":
      return (
        <p className={styles.stub}>
          Highlight rules and when-highlighted actions arrive with M5 step 6.
          The rules engine itself is already live server-side.
        </p>
      );
    case "away":
      return (
        <p className={styles.stub}>
          Auto-away and chat-log export arrive with M5 step 7.
        </p>
      );
    case "notifications":
      return (
        <p className={styles.stub}>
          Desktop notifications and mutes arrive with M5 step 8.
        </p>
      );
    case "network":
      return (
        <p className={styles.stub}>
          Connection diagnostics arrive with a later milestone.
        </p>
      );
  }
}
