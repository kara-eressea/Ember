// Notifications pane (COMPONENTS.md §12, M5 step 8): desktop notifications
// on mention/PM behind the browser permission flow, the show-preview
// privacy toggle, and the mute overrides — per identity here, per
// conversation via the 🔕 chip in conversation headers (this pane lists
// and clears them). Mutes silence alerts only; badges and tint still
// accrue (decisions.md §10).

import { useEffect, useState } from "react";
import { PREFS_DEFAULTS } from "@emberchat/protocol";
import {
  ensureNotifyPermission,
  notificationsSupported,
} from "../../lib/desktop-notify.js";
import { api } from "../../lib/api.js";
import {
  disablePush,
  enablePush,
  pushEnabledHere,
  pushSupported,
} from "../../lib/push.js";
import { useSessionsStore } from "../../stores/sessions.js";
import { FieldRow, GroupLabel, Toggle } from "./controls.js";
import { patchPrefs } from "./patch.js";
import styles from "./prefs.module.css";

/** What to say when `enablePush` comes back with something other than a
 * subscription. `enabled` has nothing to report. */
const PUSH_ERRORS: Record<
  Awaited<ReturnType<typeof enablePush>>,
  string | undefined
> = {
  enabled: undefined,
  denied:
    "Notifications are blocked — allow them in your browser's site settings first.",
  unsupported: "This browser cannot receive push notifications.",
  unavailable: "This server has no push keys configured.",
  failed: "Could not subscribe for push notifications. Try again in a moment.",
};

export function NotificationsPane({ identityId }: { identityId: string }) {
  const prefs = useSessionsStore(
    (s) => s.sessions[identityId]?.prefs ?? PREFS_DEFAULTS,
  );
  const identities = useSessionsStore((s) => s.identities) ?? [];
  const [permissionError, setPermissionError] = useState<string>();

  const set = (patch: Parameters<typeof patchPrefs>[1]) => {
    void patchPrefs(identityId, patch);
  };

  /**
   * Push is device state, so its row is not a pref: it reads the local flag
   * and asks the server once whether this instance has VAPID keys at all.
   * `undefined` means the answer has not come back — the row stays hidden
   * until it does, so a self-host without push never flashes a control. The
   * browser half is derived rather than stored: `PushManager` either exists
   * in this engine or does not, and nothing in a session changes it.
   */
  const [instanceHasPush, setInstanceHasPush] = useState<boolean>();
  const pushAvailable = pushSupported() && instanceHasPush === true;
  const [pushOn, setPushOn] = useState(pushEnabledHere);
  const [pushBusy, setPushBusy] = useState(false);
  const [pushError, setPushError] = useState<string>();

  useEffect(() => {
    if (!pushSupported()) {
      return; // nothing to ask about — the row cannot render either way
    }
    let live = true;
    void api
      .getPushVapidKey()
      .then((capability) => {
        if (live) {
          setInstanceHasPush(capability.enabled);
        }
      })
      .catch(() => {
        if (live) {
          setInstanceHasPush(false);
        }
      });
    return () => {
      live = false;
    };
  }, []);

  async function togglePush(on: boolean): Promise<void> {
    setPushError(undefined);
    setPushBusy(true);
    try {
      if (!on) {
        await disablePush();
        setPushOn(false);
        return;
      }
      const result = await enablePush();
      setPushOn(result === "enabled");
      setPushError(PUSH_ERRORS[result]);
      if (result === "unavailable") {
        // The keys went away between the pane opening and the toggle — take
        // the control with them rather than leave a dead switch on screen.
        setInstanceHasPush(false);
      }
    } finally {
      setPushBusy(false);
    }
  }

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
        label="On notes & friend requests"
        help="Website events (RTB) — reading and replying stay on f-list.net"
      >
        <Toggle
          label="On notes & friend requests"
          checked={prefs.desktopNotifyNotes}
          disabled={!notificationsSupported()}
          onChange={(desktopNotifyNotes) => {
            if (desktopNotifyNotes) {
              void enableDesktop({ desktopNotifyNotes });
            } else {
              set({ desktopNotifyNotes });
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
        (prefs.desktopNotifyMentions ||
          prefs.desktopNotifyPms ||
          prefs.desktopNotifyNotes) &&
        notificationsSupported() &&
        Notification.permission !== "granted" && (
          <p className={styles.paneError} role="alert">
            Notifications are blocked in your browser's site settings — none
            will show until you re-allow them there.
          </p>
        )}

      {/* Web Push (design/web-push.md §4). Per device, not per account: the
          subscription belongs to this browser install, so it is the one
          control in this window that does not go through prefs. Hidden
          outright where it could not work — no PushManager here, or an
          instance with no VAPID keys. */}
      {pushAvailable && (
        <>
          <GroupLabel>Push notifications</GroupLabel>
          <FieldRow
            label="On this device"
            help="Alerts arrive even with the app closed — the server keeps your session"
          >
            <Toggle
              label="Push notifications on this device"
              checked={pushOn}
              disabled={pushBusy}
              onChange={(on) => {
                void togglePush(on);
              }}
            />
          </FieldRow>
          <p className={styles.paneNote}>
            On iPhone and iPad, add this site to the Home Screen first — Safari
            only delivers push to installed apps.
          </p>
          {pushError !== undefined && (
            <p className={styles.paneError} role="alert">
              {pushError}
            </p>
          )}
          {pushOn &&
            pushError === undefined &&
            notificationsSupported() &&
            Notification.permission !== "granted" && (
              <p className={styles.paneError} role="alert">
                Notifications are blocked in your browser's site settings — no
                push will show until you re-allow them there.
              </p>
            )}
        </>
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
