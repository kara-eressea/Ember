// Notifications pane (COMPONENTS.md §12, M5 step 8): desktop notifications
// on mention/PM behind the browser permission flow, the show-preview
// privacy toggle, and the mute overrides — per identity here, per
// conversation via the 🔕 chip in conversation headers (this pane lists
// and clears them). Mutes silence alerts only; badges and tint still
// accrue (decisions.md §10).

import { useState } from "react";
import { PREFS_DEFAULTS } from "@emberchat/protocol";
import {
  ensureNotifyPermission,
  notificationsSupported,
} from "../../lib/desktop-notify.js";
import { useSessionsStore } from "../../stores/sessions.js";
import { FieldRow, GroupLabel, Toggle } from "./controls.js";
import { patchPrefs } from "./patch.js";
import styles from "./prefs.module.css";

export function NotificationsPane({ identityId }: { identityId: string }) {
  const prefs = useSessionsStore(
    (s) => s.sessions[identityId]?.prefs ?? PREFS_DEFAULTS,
  );
  const identities = useSessionsStore((s) => s.identities) ?? [];
  const [permissionError, setPermissionError] = useState<string>();

  const set = (patch: Parameters<typeof patchPrefs>[1]) => {
    void patchPrefs(identityId, patch);
  };

  /** Flip a desktop toggle on only once the browser permission exists. */
  async function enableDesktop(
    patch: Parameters<typeof patchPrefs>[1],
  ): Promise<void> {
    setPermissionError(undefined);
    const permission = await ensureNotifyPermission();
    if (permission === "granted") {
      set(patch);
    } else {
      setPermissionError(
        permission === "unsupported"
          ? "This browser does not support desktop notifications."
          : "Notifications are blocked — allow them in your browser's site settings first.",
      );
    }
  }

  function toggleIdentityMute(id: string, mute: boolean) {
    const next = mute
      ? [...prefs.mutedIdentityIds, id]
      : prefs.mutedIdentityIds.filter((entry) => entry !== id);
    set({ mutedIdentityIds: next });
  }

  return (
    <>
      <GroupLabel>Desktop notifications</GroupLabel>
      <FieldRow
        label="On mentions"
        help="A highlight rule or your name matched a message"
      >
        <Toggle
          label="On mentions"
          checked={prefs.desktopNotifyMentions}
          disabled={!notificationsSupported()}
          onChange={(desktopNotifyMentions) => {
            if (desktopNotifyMentions) {
              void enableDesktop({ desktopNotifyMentions });
            } else {
              set({ desktopNotifyMentions });
            }
          }}
        />
      </FieldRow>
      <FieldRow label="On private messages">
        <Toggle
          label="On private messages"
          checked={prefs.desktopNotifyPms}
          disabled={!notificationsSupported()}
          onChange={(desktopNotifyPms) => {
            if (desktopNotifyPms) {
              void enableDesktop({ desktopNotifyPms });
            } else {
              set({ desktopNotifyPms });
            }
          }}
        />
      </FieldRow>
      <FieldRow
        label="Show message preview"
        help="Off shows only who wrote, never what"
      >
        <Toggle
          label="Show message preview"
          checked={prefs.notifyShowContent}
          onChange={(notifyShowContent) => {
            set({ notifyShowContent });
          }}
        />
      </FieldRow>
      {permissionError && (
        <p className={styles.paneError} role="alert">
          {permissionError}
        </p>
      )}
      {/* Permission can be revoked in browser settings after enabling — the
          pref would otherwise sit on and silently never fire. */}
      {!permissionError &&
        (prefs.desktopNotifyMentions || prefs.desktopNotifyPms) &&
        notificationsSupported() &&
        Notification.permission !== "granted" && (
          <p className={styles.paneError} role="alert">
            Notifications are blocked in your browser's site settings — none
            will show until you re-allow them there.
          </p>
        )}

      <GroupLabel>Muted identities</GroupLabel>
      <p className={styles.paneNote}>
        Muting silences sounds, title flashes and notifications — unread and
        mention badges still count.
      </p>
      {identities.map((identity) => (
        <FieldRow key={identity.id} label={identity.name}>
          <Toggle
            label={`Mute alerts for ${identity.name}`}
            checked={prefs.mutedIdentityIds.includes(identity.id)}
            onChange={(mute) => {
              toggleIdentityMute(identity.id, mute);
            }}
          />
        </FieldRow>
      ))}

      <GroupLabel>Muted conversations</GroupLabel>
      <MutedConversations identityId={identityId} />
    </>
  );
}

/** The muted-conversation review list — muting happens via the header 🔕. */
function MutedConversations({ identityId }: { identityId: string }) {
  const prefs = useSessionsStore(
    (s) => s.sessions[identityId]?.prefs ?? PREFS_DEFAULTS,
  );
  const sessions = useSessionsStore((s) => s.sessions);

  function labelFor(convId: string): string {
    for (const session of Object.values(sessions)) {
      for (const channel of Object.values(session.channels)) {
        if (channel.convId === convId) {
          return `# ${channel.title}`;
        }
      }
      const dm = session.dms[convId];
      if (dm) {
        return dm.partner;
      }
    }
    // A conversation no synced slice knows (other device's identity, or
    // since-left) — still unmutable, just unnamed.
    return "(unknown conversation)";
  }

  if (prefs.mutedConvIds.length === 0) {
    return (
      <p className={styles.rulesEmpty}>
        Nothing muted — use the 🔕 chip in a conversation's header.
      </p>
    );
  }
  return (
    <ul className={styles.ruleList} aria-label="Muted conversations">
      {prefs.mutedConvIds.map((convId) => (
        <li key={convId} className={styles.ruleChip}>
          <span className={styles.rulePattern}>{labelFor(convId)}</span>
          <button
            type="button"
            className={styles.ruleRemove}
            aria-label={`Unmute ${labelFor(convId)}`}
            onClick={() => {
              void patchPrefs(identityId, {
                mutedConvIds: prefs.mutedConvIds.filter(
                  (entry) => entry !== convId,
                ),
              });
            }}
          >
            ✕
          </button>
        </li>
      ))}
    </ul>
  );
}
