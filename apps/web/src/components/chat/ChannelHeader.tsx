// ChannelHeader (COMPONENTS.md §5). F-Chat channels carry one CDS
// description — it fills the collapsed description row; the separate
// editable TOPIC row has no wire counterpart and is omitted. For DMs the
// header shows the partner with presence and the TPN typing state.

import { useState } from "react";
import { presenceDot } from "../../lib/presence.js";
import type { ChannelView, DmView } from "../../stores/sessions.js";
import { useUiStore } from "../../stores/ui.js";
import styles from "./chat.module.css";

const DESCRIPTION_CLAMP = 140;

export function ChannelHeader({ channel }: { channel: ChannelView }) {
  const [expanded, setExpanded] = useState(false);
  const toggleMembers = useUiStore((s) => s.toggleMembers);
  const description = channel.description.trim();
  const clampable = description.length > DESCRIPTION_CLAMP;

  return (
    <header className={styles.header}>
      <div className={styles.headerRow}>
        <span className={styles.headerGlyph}>#</span>
        <h1 className={styles.headerTitle}>{channel.title}</h1>
        <span className={styles.headerSpacer} />
        <button
          className={styles.headerButton}
          onClick={toggleMembers}
          title="Toggle member list"
        >
          ☰ {channel.members.length}
        </button>
      </div>
      {description && (
        <div
          className={`${styles.description} ${expanded ? "" : (styles.descriptionClamped ?? "")}`}
        >
          {description}{" "}
          {clampable && expanded && (
            <button
              className={styles.showMore}
              onClick={() => {
                setExpanded(false);
              }}
            >
              Show less
            </button>
          )}
        </div>
      )}
      {clampable && !expanded && (
        <button
          className={styles.showMore}
          onClick={() => {
            setExpanded(true);
          }}
        >
          Show more
        </button>
      )}
    </header>
  );
}

export function DmHeader({ dm }: { dm: DmView }) {
  const dot = presenceDot(dm.online, dm.status);
  return (
    <header className={styles.header}>
      <div className={styles.headerRow}>
        <span
          className={styles.headerDot}
          style={{
            background:
              dot === "ok"
                ? "var(--eb-ok)"
                : dot === "warn"
                  ? "var(--eb-warn)"
                  : "var(--eb-faint)",
          }}
        />
        <h1 className={styles.headerTitle}>{dm.partner}</h1>
        {dm.typing === "typing" && (
          <span className={styles.typing}>is typing…</span>
        )}
        <span className={styles.headerSpacer} />
      </div>
      {(dm.statusmsg || dm.status) && (
        <div className={styles.description}>
          {dm.online
            ? `${dm.status}${dm.statusmsg ? ` — ${dm.statusmsg}` : ""}`
            : "offline"}
        </div>
      )}
    </header>
  );
}
