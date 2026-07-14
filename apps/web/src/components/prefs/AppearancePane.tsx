// Appearance pane (COMPONENTS.md §12 + milestone-5.md): accent, base theme,
// density, font size, timestamps, grouping, aligned columns. Every control
// writes through patchPrefs — optimistic locally, synced to every device
// via the prefs fan-out (decisions.md §10). The join/part/quit toggle joins
// in M5 step 5, when those lines exist to hide.

import { PREFS_DEFAULTS } from "@emberchat/protocol";
import { useSessionsStore } from "../../stores/sessions.js";
import { ACCENTS, type AccentId } from "../../theme/tokens.js";
import { FieldRow, GroupLabel, Segmented, Swatch, Toggle } from "./controls.js";
import { patchPrefs } from "./patch.js";
import styles from "./prefs.module.css";

export function AppearancePane({ identityId }: { identityId: string }) {
  const prefs = useSessionsStore(
    (s) => s.sessions[identityId]?.prefs ?? PREFS_DEFAULTS,
  );
  const set = (patch: Parameters<typeof patchPrefs>[1]) => {
    void patchPrefs(identityId, patch);
  };

  return (
    <>
      <GroupLabel>Theme</GroupLabel>
      <FieldRow label="Accent color" help="Synced across your devices">
        <div
          className={styles.swatchRow}
          role="radiogroup"
          aria-label="Accent color"
        >
          {(Object.keys(ACCENTS) as AccentId[]).map((id) => (
            <Swatch
              key={id}
              color={ACCENTS[id].hex}
              label={ACCENTS[id].label}
              selected={prefs.accent === id}
              onClick={() => {
                set({ accent: id });
              }}
            />
          ))}
        </div>
      </FieldRow>
      <FieldRow label="Base theme">
        <Segmented
          label="Base theme"
          options={[
            { value: "slate", label: "Slate" },
            { value: "charcoal", label: "Charcoal" },
          ]}
          value={prefs.baseTheme}
          onChange={(baseTheme) => {
            set({ baseTheme });
          }}
        />
      </FieldRow>

      <GroupLabel>Messages</GroupLabel>
      <FieldRow label="Message density">
        <Segmented
          label="Message density"
          options={[
            { value: "cozy", label: "Cozy" },
            { value: "compact", label: "Compact" },
          ]}
          value={prefs.density}
          onChange={(density) => {
            set({ density });
          }}
        />
      </FieldRow>
      <FieldRow label="Message font size">
        <Segmented
          label="Message font size"
          options={[
            { value: "s", label: "S" },
            { value: "m", label: "M" },
            { value: "l", label: "L" },
          ]}
          value={prefs.fontSize}
          onChange={(fontSize) => {
            set({ fontSize });
          }}
        />
      </FieldRow>
      <FieldRow
        label="Group consecutive messages"
        help="Hide the sender on back-to-back messages from the same person"
      >
        <Toggle
          label="Group consecutive messages"
          checked={prefs.groupConsecutive}
          onChange={(groupConsecutive) => {
            set({ groupConsecutive });
          }}
        />
      </FieldRow>
      <FieldRow
        label="Aligned columns"
        help="Fixed time and name columns so message text lines up"
      >
        <Toggle
          label="Aligned columns"
          checked={prefs.alignedColumns}
          onChange={(alignedColumns) => {
            set({ alignedColumns });
          }}
        />
      </FieldRow>
      <FieldRow
        label="Show join/part/quit"
        help="Live channel comings and goings — not kept in history"
      >
        <Toggle
          label="Show join/part/quit"
          checked={prefs.showJoinPartQuit}
          onChange={(showJoinPartQuit) => {
            set({ showJoinPartQuit });
          }}
        />
      </FieldRow>

      <GroupLabel>Eicons</GroupLabel>
      <FieldRow label="Eicon display">
        <Segmented
          label="Eicon display"
          options={[
            { value: "inline", label: "Inline" },
            { value: "name", label: "Name only" },
          ]}
          value={prefs.eiconDisplay}
          onChange={(eiconDisplay) => {
            set({ eiconDisplay });
          }}
        />
      </FieldRow>
      <FieldRow
        label="Animate eicons"
        help="Off freezes them on their first frame"
      >
        <Toggle
          label="Animate eicons"
          checked={prefs.animateEicons}
          onChange={(animateEicons) => {
            set({ animateEicons });
          }}
        />
      </FieldRow>

      <GroupLabel>Timestamps</GroupLabel>
      <FieldRow label="Timestamp format">
        <Segmented
          label="Timestamp format"
          options={[
            { value: "time", label: "[12:04]" },
            { value: "seconds", label: "[12:04:33]" },
            { value: "off", label: "Off" },
          ]}
          value={prefs.timestampFormat}
          onChange={(timestampFormat) => {
            set({ timestampFormat });
          }}
        />
      </FieldRow>
      <FieldRow label="24-hour clock">
        <Toggle
          label="24-hour clock"
          checked={prefs.use24HourClock}
          onChange={(use24HourClock) => {
            set({ use24HourClock });
          }}
        />
      </FieldRow>
    </>
  );
}
