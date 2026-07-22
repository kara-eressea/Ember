// Appearance pane (COMPONENTS.md §12 + milestone-5.md): accent, base theme,
// density, font size, timestamps, grouping, aligned columns. Every control
// writes through patchPrefs — optimistic locally, synced to every device
// via the prefs fan-out (decisions.md §10). The join/part/quit toggle joins
// in M5 step 5, when those lines exist to hide.

import { useState, type FormEvent } from "react";
import {
  DEFAULT_IMAGE_PREVIEW_HOSTS,
  IMAGE_PREVIEW_HOST,
  PREFS_DEFAULTS,
} from "@emberchat/protocol";
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
            { value: "parchment", label: "Parchment" },
          ]}
          value={prefs.baseTheme}
          onChange={(baseTheme) => {
            set({ baseTheme });
          }}
        />
      </FieldRow>
      <FieldRow
        label="Colorblind-friendly status colors"
        help="Okabe–Ito ok/warn/danger hues, and presence dots gain distinct shapes so hue is never the only signal"
      >
        <Toggle
          label="Colorblind-friendly status colors"
          checked={prefs.colorblindMode}
          onChange={(colorblindMode) => {
            set({ colorblindMode });
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
      <FieldRow
        label="Eicon search"
        help="Search uses an eicon index the server downloads from xariah.net, a third-party service — your search text never leaves the server"
      >
        <Toggle
          label="Eicon search"
          checked={prefs.eiconSearchEnabled}
          onChange={(eiconSearchEnabled) => {
            set({ eiconSearchEnabled });
          }}
        />
      </FieldRow>

      <GroupLabel>Link previews</GroupLabel>
      <FieldRow
        label="Media link previews"
        help="Loading a preview fetches the image straight from its host — the host sees your IP, like any image on a webpage. Click mode: a plain click on a media link previews it; Ctrl/Cmd+click follows the link"
      >
        <Segmented
          label="Media link previews"
          options={[
            { value: "off", label: "Off" },
            { value: "hover", label: "Hover" },
            { value: "click", label: "Click" },
          ]}
          value={prefs.linkPreviewMode}
          onChange={(linkPreviewMode) => {
            set({ linkPreviewMode });
          }}
        />
      </FieldRow>
      <ImagePreviewHosts
        hosts={prefs.imagePreviewHosts}
        onChange={(imagePreviewHosts) => {
          set({ imagePreviewHosts });
        }}
      />

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

const MAX_PREVIEW_HOSTS = 100;

/** Strip anything that isn't a bare hostname: scheme, path, query, port, and
 * surrounding whitespace — so pasting a full URL still yields just its host. */
function normalizeHostInput(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, "") // scheme://
    .replace(/[/?#].*$/, "") // path / query / fragment
    .replace(/:\d+$/, ""); // :port
}

/**
 * The image-preview allowlist editor (#215): a chip list of hosts, an add
 * form with light hostname validation, and a reset-to-defaults affordance.
 * The whole array is patched on every change (the prefs array convention).
 */
function ImagePreviewHosts({
  hosts,
  onChange,
}: {
  hosts: readonly string[];
  onChange: (hosts: string[]) => void;
}) {
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string>();

  const isDefault =
    hosts.length === DEFAULT_IMAGE_PREVIEW_HOSTS.length &&
    DEFAULT_IMAGE_PREVIEW_HOSTS.every((host, index) => hosts[index] === host);

  function add(event: FormEvent) {
    event.preventDefault();
    const host = normalizeHostInput(draft);
    if (host === "") {
      return;
    }
    if (!IMAGE_PREVIEW_HOST.test(host)) {
      setError("Enter a site address like imgur.com");
      return;
    }
    if (hosts.includes(host)) {
      setError("That site is already on the list");
      return;
    }
    if (hosts.length >= MAX_PREVIEW_HOSTS) {
      setError(`You can add up to ${String(MAX_PREVIEW_HOSTS)} sites`);
      return;
    }
    onChange([...hosts, host]);
    setDraft("");
    setError(undefined);
  }

  return (
    <div className={styles.rulesEditor}>
      <div className={styles.fieldText}>
        <div className={styles.fieldLabel}>
          Show image previews from these sites
        </div>
        <div className={styles.fieldHelp}>
          Previews load only for sites on this list — links from anywhere else
          stay plain links you can open in a new tab.
        </div>
      </div>
      <div className={styles.hostEditorBody}>
        {hosts.length === 0 ? (
          <p className={styles.rulesEmpty}>
            No sites yet — add one below to see image previews.
          </p>
        ) : (
          <ul className={styles.ruleList} aria-label="Allowed preview sites">
            {hosts.map((host) => (
              <li key={host} className={styles.ruleChip}>
                <span className={styles.rulePattern}>{host}</span>
                <button
                  type="button"
                  className={styles.ruleRemove}
                  aria-label={`Remove ${host}`}
                  onClick={() => {
                    onChange(hosts.filter((entry) => entry !== host));
                    setError(undefined);
                  }}
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
        )}
        <form className={styles.ruleForm} onSubmit={add}>
          <input
            className={styles.textInput}
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value);
              setError(undefined);
            }}
            maxLength={253}
            placeholder="imgur.com"
            aria-label="Site address"
          />
          <button
            type="submit"
            className={styles.ruleAdd}
            disabled={draft.trim() === "" || hosts.length >= MAX_PREVIEW_HOSTS}
          >
            Add
          </button>
        </form>
        <p className={styles.rulesHint}>
          Enter a site address only — no “https://” or path.
          {!isDefault && (
            <>
              {" "}
              <button
                type="button"
                className={styles.linkButton}
                onClick={() => {
                  onChange([...DEFAULT_IMAGE_PREVIEW_HOSTS]);
                  setError(undefined);
                }}
              >
                Reset to defaults
              </button>
            </>
          )}
        </p>
        {error !== undefined && (
          <p className={styles.paneError} role="alert">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
