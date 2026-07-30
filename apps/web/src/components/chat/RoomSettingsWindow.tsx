// Room-settings window (follows #312/#314): the owner/op controls, moved from
// a header popover into a small Preferences-style modal (ModalWindow shell +
// the prefs rail/pane chrome). Two panes — "Settings" (invite, visibility,
// message mode, description) and "Banned characters" (the banlist promoted
// from a log-only dump into a list with per-row unban). Every action is the
// same gateway command as before; this is a presentation move plus the
// banlist relocation.

import { useEffect, useMemo, useState, type FormEvent } from "react";
import { gateway } from "../../gateway/socket.js";
import { useMessagesStore } from "../../stores/messages.js";
import { GroupLabel, Segmented } from "../prefs/controls.js";
import { ModalWindow } from "../shell/ModalWindow.js";
import { parseBanlistLine } from "./banlist.js";
import prefs from "../prefs/prefs.module.css";
import styles from "./room-settings.module.css";

const PANES = [
  { id: "settings", label: "Settings", glyph: "⚙" },
  { id: "banned", label: "Banned characters", glyph: "⊘" },
] as const;

type PaneId = (typeof PANES)[number]["id"];

export function RoomSettingsWindow({
  identityId,
  channelKey,
  convId,
  title,
  isPrivateRoom,
  mode,
  description,
  onClose,
}: {
  identityId: string;
  channelKey: string;
  convId: string;
  title: string;
  isPrivateRoom: boolean;
  mode: string;
  description: string;
  onClose: () => void;
}) {
  const [pane, setPane] = useState<PaneId>("settings");
  const active = PANES.find((entry) => entry.id === pane) ?? PANES[0];

  return (
    <ModalWindow
      ariaLabel={`Room settings — ${title}`}
      windowClassName={styles.roomWindow}
      onClose={onClose}
    >
      <nav className={prefs.rail} aria-label="Room settings sections">
        <div className={prefs.railTitle}>Room settings</div>
        <div className={styles.railSub}>{title}</div>
        {PANES.map((entry) => (
          <button
            key={entry.id}
            type="button"
            className={`${prefs.railItem} ${
              entry.id === pane ? prefs.railItemActive : ""
            }`}
            aria-current={entry.id === pane ? "page" : undefined}
            onClick={() => {
              setPane(entry.id);
            }}
          >
            <span className={prefs.railGlyph} aria-hidden>
              {entry.glyph}
            </span>
            {entry.label}
          </button>
        ))}
      </nav>
      <section className={prefs.pane}>
        <header className={prefs.paneHead}>
          <h2 className={prefs.paneTitle}>{active.label}</h2>
          <button
            type="button"
            className={prefs.close}
            aria-label="Close room settings"
            onClick={onClose}
          >
            ✕
          </button>
        </header>
        <div className={prefs.paneBody}>
          {pane === "settings" ? (
            <SettingsPane
              identityId={identityId}
              channelKey={channelKey}
              isPrivateRoom={isPrivateRoom}
              mode={mode}
              description={description}
            />
          ) : (
            <BannedPane
              identityId={identityId}
              channelKey={channelKey}
              convId={convId}
            />
          )}
        </div>
      </section>
    </ModalWindow>
  );
}

function SettingsPane({
  identityId,
  channelKey,
  isPrivateRoom,
  mode,
  description,
}: {
  identityId: string;
  channelKey: string;
  isPrivateRoom: boolean;
  mode: string;
  description: string;
}) {
  const [character, setCharacter] = useState("");
  const [draft, setDraft] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [info, setInfo] = useState<string>();
  // F-Chat never reports a room's open/invite-only state, so we can't seed
  // this — it tracks the last choice made here and drives the highlight.
  const [visibility, setVisibility] = useState<"public" | "private" | "">("");

  async function invite(event: FormEvent) {
    event.preventDefault();
    const target = character.trim();
    if (!target || busy) {
      return;
    }
    setBusy(true);
    setInfo(undefined);
    try {
      const ack = await gateway.cmd({
        identityId,
        action: "channel.invite",
        d: { key: channelKey, character: target },
      });
      if (ack.ok) {
        setCharacter("");
        setInfo(`Invite sent to ${target}`);
      } else {
        setInfo(ack.error ?? "Could not invite");
      }
    } finally {
      setBusy(false);
    }
  }

  async function setStatus(status: "public" | "private") {
    if (busy) {
      return;
    }
    setBusy(true);
    setInfo(undefined);
    try {
      const ack = await gateway.cmd({
        identityId,
        action: "channel.status",
        d: { key: channelKey, status },
      });
      if (ack.ok) {
        setVisibility(status);
      }
      setInfo(
        ack.ok
          ? status === "public"
            ? "Room is now open and listed"
            : "Room is now invite-only"
          : (ack.error ?? "Could not change the room status"),
      );
    } finally {
      setBusy(false);
    }
  }

  /** Shared shape for the op commands whose feedback is just the result. */
  async function run(
    label: string,
    command: Parameters<typeof gateway.cmd>[0],
  ) {
    if (busy) {
      return;
    }
    setBusy(true);
    setInfo(undefined);
    try {
      const ack = await gateway.cmd(command);
      setInfo(ack.ok ? label : (ack.error ?? "Command failed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {isPrivateRoom && (
        <>
          <section className={styles.section}>
            <GroupLabel>Invite someone</GroupLabel>
            <form
              className={styles.inlineForm}
              onSubmit={(event) => {
                void invite(event);
              }}
            >
              <input
                className={styles.input}
                value={character}
                onChange={(e) => {
                  setCharacter(e.target.value);
                }}
                placeholder="Character name…"
                aria-label="Invite a character"
              />
              <button
                className={styles.primaryBtn}
                type="submit"
                disabled={busy}
              >
                Invite
              </button>
            </form>
          </section>
          <section className={styles.section}>
            <GroupLabel>Who can join</GroupLabel>
            <Segmented
              label="Who can join"
              value={visibility as "public" | "private"}
              options={[
                { value: "public", label: "Anyone" },
                { value: "private", label: "Invite only" },
              ]}
              onChange={(next) => {
                void setStatus(next);
              }}
            />
            <p className={styles.hint}>
              F-Chat can’t tell us the current setting — pick one to change it.
            </p>
          </section>
        </>
      )}
      <section className={styles.section}>
        <GroupLabel>Allowed messages</GroupLabel>
        <Segmented
          label="Allowed messages"
          value={mode as "chat" | "ads" | "both"}
          options={[
            { value: "chat", label: "Chat" },
            { value: "ads", label: "Ads" },
            { value: "both", label: "Both" },
          ]}
          onChange={(next) => {
            if (next === mode) {
              return;
            }
            void run(`Allowed messages set to ${next}`, {
              identityId,
              action: "channel.mode",
              d: { key: channelKey, mode: next },
            });
          }}
        />
      </section>
      <section className={styles.section}>
        <GroupLabel>Description</GroupLabel>
        <form
          className={styles.column}
          onSubmit={(event) => {
            event.preventDefault();
            void run("Description updated", {
              identityId,
              action: "channel.describe",
              d: { key: channelKey, description: draft ?? description },
            });
          }}
        >
          <textarea
            className={styles.textarea}
            value={draft ?? description}
            onChange={(e) => {
              setDraft(e.target.value);
            }}
            rows={4}
            aria-label="Channel description"
          />
          <button
            className={`${styles.primaryBtn} ${styles.selfEnd}`}
            type="submit"
            disabled={busy}
          >
            Save
          </button>
        </form>
      </section>
      {info && (
        <p className={styles.info} role="status">
          {info}
        </p>
      )}
    </>
  );
}

function BannedPane({
  identityId,
  channelKey,
  convId,
}: {
  identityId: string;
  channelKey: string;
  convId: string;
}) {
  const [busy, setBusy] = useState(false);
  const messages = useMessagesStore((s) => s.buffers[convId]?.messages);

  // The banlist has no structured wire response — it lands as a channel SYS.
  // Reuse that plumbing: request it, then read the freshest matching line
  // back out of the buffer. `null` = we haven't seen an answer yet.
  const banned = useMemo<string[] | null>(() => {
    if (!messages) {
      return null;
    }
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const message = messages[i];
      if (message?.kind !== "sys") {
        continue;
      }
      const parsed = parseBanlistLine(message.bbcode);
      if (parsed) {
        return parsed;
      }
    }
    return null;
  }, [messages]);

  async function requestBanlist() {
    await gateway.cmd({
      identityId,
      action: "channel.banlist",
      d: { key: channelKey },
    });
  }

  // Ask for the list once when the pane opens — the answer streams into the
  // buffer and the selector above renders it.
  useEffect(() => {
    void gateway.cmd({
      identityId,
      action: "channel.banlist",
      d: { key: channelKey },
    });
  }, [identityId, channelKey]);

  async function unban(character: string) {
    if (busy) {
      return;
    }
    setBusy(true);
    try {
      await gateway.cmd({
        identityId,
        action: "channel.unban",
        d: { key: channelKey, character },
      });
      // Refresh so the lifted ban drops off the list.
      await requestBanlist();
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className={styles.banHead}>
        <p className={styles.banIntro}>
          People banned from this room. Lifting a ban lets them rejoin.
        </p>
        <button
          type="button"
          className={styles.secondaryBtn}
          disabled={busy}
          onClick={() => {
            void requestBanlist();
          }}
        >
          Refresh
        </button>
      </div>
      {banned === null ? (
        <p className={styles.empty}>Loading the banned list…</p>
      ) : banned.length === 0 ? (
        <p className={styles.empty}>No one is banned from this room.</p>
      ) : (
        <ul className={styles.banList}>
          {banned.map((name) => (
            <li key={name} className={styles.banRow}>
              <span className={styles.banName}>{name}</span>
              <button
                type="button"
                className={styles.secondaryBtn}
                disabled={busy}
                aria-label={`Lift ban on ${name}`}
                onClick={() => {
                  void unban(name);
                }}
              >
                Lift ban
              </button>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
