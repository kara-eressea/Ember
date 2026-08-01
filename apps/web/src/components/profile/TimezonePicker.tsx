// "Where are they, roughly?" — the per-character timezone the DM header and
// DM sidebar clocks read from. Sits with the private note on the Insights tab
// because it is the same kind of thing: your own annotation on someone else,
// visible only to you.
//
// Typing is a filtered datalist over the runtime's IANA zones; only an exact
// zone id commits, and the ✕ clears back to whatever F-List's profile says.

import { useId, useState } from "react";
import { saveTimezone } from "../../stores/profile.js";
import { clockTitle, localClock } from "../../lib/local-time.js";
import { useMinuteClock } from "../../lib/useMinuteClock.js";
import styles from "./profile.module.css";

/** Every zone the runtime knows — a fixed ~400-entry list, so it is built
 * once for the session rather than per mount. */
let zoneCache: string[] | undefined;
function allZones(): string[] {
  if (!zoneCache) {
    try {
      zoneCache = Intl.supportedValuesOf("timeZone");
    } catch {
      zoneCache = [];
    }
  }
  return zoneCache;
}

export function TimezonePicker({
  identityId,
  name,
  initial,
  flistOffset,
}: {
  identityId: string;
  name: string;
  initial: string | null;
  /** F-List's own numeric UTC offset — the fallback the clock uses. */
  flistOffset: number | null;
}) {
  const zones = allZones();
  const [zone, setZone] = useState(initial);
  const [draft, setDraft] = useState(initial ?? "");
  const [failed, setFailed] = useState(false);
  const listId = useId();
  const now = useMinuteClock();
  const clock = localClock(now, zone, flistOffset);

  function commit(next: string | null) {
    setZone(next);
    setFailed(false);
    saveTimezone(identityId, name, next).catch(() => {
      // Keep what they typed — the field still shows it, and re-picking
      // retries.
      setFailed(true);
    });
  }

  return (
    <div className={styles.tzBlock}>
      <span className={styles.noteEyebrow}>
        <span className={styles.noteDot} aria-hidden />
        THEIR TIMEZONE
        {failed && (
          <span
            className={`${styles.noteSaved} ${styles.noteError ?? ""}`}
            role="status"
          >
            ⚠ Not saved
          </span>
        )}
      </span>
      <div className={styles.tzRow}>
        <input
          className={styles.tzInput}
          list={listId}
          value={draft}
          placeholder="Search zones — e.g. Europe/Berlin"
          aria-label={`Timezone for ${name}`}
          onChange={(event) => {
            const next = event.target.value;
            setDraft(next);
            // Datalist picks arrive as a plain change; commit as soon as the
            // text is a real zone, so there is no separate save step.
            if (zones.includes(next)) {
              commit(next);
            }
          }}
        />
        <datalist id={listId}>
          {zones.map((value) => (
            <option key={value} value={value} />
          ))}
        </datalist>
        {zone && (
          <button
            type="button"
            className={styles.tzClear}
            title="Forget this timezone"
            aria-label={`Clear the timezone for ${name}`}
            onClick={() => {
              setDraft("");
              commit(null);
            }}
          >
            ✕
          </button>
        )}
      </div>
      <span className={styles.noteFoot}>
        {clock ? (
          <span title={clockTitle(clock, name)}>
            Local time {clock.time} ·{" "}
            {clock.source === "user"
              ? "your answer"
              : `${clock.zone}, from their profile`}
          </span>
        ) : (
          "only you can see this · their profile doesn't say"
        )}
      </span>
    </div>
  );
}
