// General pane (COMPONENTS.md §12): account-wide behavior defaults. Its
// first real control lands with M6 — roleplay-ad visibility. hideAds is
// what every channel inherits; the channel header's ads chip stores
// per-channel exceptions on top of it.

import { useEffect, useState } from "react";
import { Link } from "react-router";
import { PREFS_DEFAULTS } from "@emberchat/protocol";
import { api, type MetaDto } from "../../lib/api.js";
import { appConfig } from "../../lib/config.js";
import { useSessionsStore } from "../../stores/sessions.js";
import { FieldRow, GroupLabel, Toggle } from "./controls.js";
import { patchPrefs } from "./patch.js";
import styles from "./prefs.module.css";

export function GeneralPane({
  identityId,
  onClose,
}: {
  identityId: string;
  onClose: () => void;
}) {
  const prefs = useSessionsStore(
    (s) => s.sessions[identityId]?.prefs ?? PREFS_DEFAULTS,
  );
  // About surface (M7): running version + the server's quiet update hint.
  const [meta, setMeta] = useState<MetaDto>();
  useEffect(() => {
    api.getMeta().then(setMeta, () => {
      // The about line just shows the name.
    });
  }, []);

  return (
    <>
      <GroupLabel>Channel list</GroupLabel>
      <FieldRow
        label="Hide offline people"
        help="Keeps offline friends, bookmarks, and direct-message partners out of the sidebar — though a pinned chat, one with unread messages, or the chat you have open always stays put. This sets all three sections at once; to show or hide offline people in just one, right-click that section's heading in the sidebar."
      >
        <Toggle
          label="Hide offline people"
          checked={
            !prefs.showOfflineFriends &&
            !prefs.showOfflineBookmarks &&
            !prefs.showOfflineDms
          }
          onChange={(hide) => {
            void patchPrefs(identityId, {
              showOfflineFriends: !hide,
              showOfflineBookmarks: !hide,
              showOfflineDms: !hide,
            });
          }}
        />
      </FieldRow>
      <GroupLabel>Message box</GroupLabel>
      <FieldRow
        label="Style formatting as you type"
        help="Shows **bold**, *italic* and friends styled right in the message box while you write, instead of in a separate preview above it. The markers stay visible, just dimmed. What you send is the same either way."
      >
        <Toggle
          label="Style formatting as you type"
          checked={prefs.inlineComposer}
          onChange={(on) => {
            void patchPrefs(identityId, { inlineComposer: on });
          }}
        />
      </FieldRow>
      <GroupLabel>Roleplay ads</GroupLabel>
      <FieldRow
        label="Hide ads everywhere"
        help="Channels inherit this default; the Show selector in a channel's header overrides it per channel. Hidden ads are kept in history."
      >
        <Toggle
          label="Hide ads everywhere"
          checked={prefs.adViewDefault === "chat"}
          onChange={(hide) => {
            void patchPrefs(identityId, {
              adViewDefault: hide ? "chat" : "both",
            });
          }}
        />
      </FieldRow>
      <GroupLabel>Accounts</GroupLabel>
      <p className={styles.stub}>
        Identities and F-List accounts are managed on the{" "}
        <Link to="/identities" onClick={onClose}>
          identity screen
        </Link>
        .
      </p>
      <GroupLabel>About</GroupLabel>
      <p className={styles.stub}>
        {appConfig().appName}
        {meta && ` v${meta.version}`}
        {meta?.updateAvailable && meta.latestVersion !== undefined && (
          <>
            {" · "}
            <a
              href={meta.releasesUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              Update available: {meta.latestVersion} ↗
            </a>
          </>
        )}
      </p>
    </>
  );
}
