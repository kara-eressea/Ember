// /help reference (M9 step 4): a static, versioned-with-the-client card of
// the slash commands, formatting markers, and search filters. Opened by the
// composer's ? button or typing /help — nothing here is fetched.

import { useEffect } from "react";
import styles from "./chat.module.css";

const SLASH_ROWS: [string, string][] = [
  ["/me action", "emote (part of the message, not a command)"],
  ["/roll 2d6+3", "roll dice in the channel (default 1d20)"],
  ["/bottle", "spin the bottle"],
  ["/help", "this reference"],
  ["/timeout Name, 30", "op: time a member out (1–90 minutes)"],
  ["/kick /ban /unban Name", "op: moderation"],
  ["/op /deop /setowner Name", "owner/op: roles"],
  ["/setmode chat|ads|both", "owner: channel message kinds"],
  ["/banlist", "op: list channel bans"],
];

const FORMAT_ROWS: [string, string][] = [
  ["**bold** · *italic* · ~~strike~~", "Markdown mode markers"],
  ["`code`", "inline code (rendered locally)"],
  ["[u]underline[/u] · [sup] [sub]", "BBCode works in both modes"],
  ["[color=red]…[/color]", "F-Chat's fixed color list"],
  ["[user]Name[/user] · [icon] · [eicon]", "names and icons"],
  ["[noparse]…[/noparse]", "show markup literally"],
];

const SEARCH_ROWS: [string, string][] = [
  ['from:Name · from:"Full Name"', "only this sender"],
  ["before:2026-01-01 · after:…", "date bounds (UTC days)"],
];

export function HelpPanel({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
      }
    }
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
    };
  }, [onClose]);

  return (
    <>
      <div className={styles.helpOverlay} onClick={onClose} />
      <div className={styles.helpPanel} role="dialog" aria-label="Help">
        <div className={styles.helpHead}>
          Commands & formatting
          <button
            type="button"
            className={styles.searchClose}
            aria-label="Close help"
            onClick={onClose}
          >
            ✕
          </button>
        </div>
        <div className={styles.helpBody}>
          <HelpSection title="Slash commands" rows={SLASH_ROWS} />
          <HelpSection title="Formatting" rows={FORMAT_ROWS} />
          <HelpSection title="Search filters (⌕)" rows={SEARCH_ROWS} />
        </div>
      </div>
    </>
  );
}

function HelpSection({
  title,
  rows,
}: {
  title: string;
  rows: [string, string][];
}) {
  return (
    <section className={styles.helpSection}>
      <div className={styles.helpSectionTitle}>{title}</div>
      {rows.map(([code, what]) => (
        <div key={code} className={styles.helpRow}>
          <code className={styles.helpCode}>{code}</code>
          <span className={styles.helpWhat}>{what}</span>
        </div>
      ))}
    </section>
  );
}
