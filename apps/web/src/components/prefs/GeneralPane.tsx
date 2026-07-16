// General pane (COMPONENTS.md §12): account-wide behavior defaults. Its
// first real control lands with M6 — roleplay-ad visibility. hideAds is
// what every channel inherits; the channel header's ads chip stores
// per-channel exceptions on top of it.

import { Link } from "react-router";
import { PREFS_DEFAULTS } from "@emberchat/protocol";
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

  return (
    <>
      <GroupLabel>Roleplay ads</GroupLabel>
      <FieldRow
        label="Hide ads everywhere"
        help="Channels inherit this default; the ♥ ads chip in a channel's header overrides it per channel. Hidden ads are kept in history."
      >
        <Toggle
          label="Hide ads everywhere"
          checked={prefs.hideAds}
          onChange={(hideAds) => {
            void patchPrefs(identityId, { hideAds });
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
    </>
  );
}
