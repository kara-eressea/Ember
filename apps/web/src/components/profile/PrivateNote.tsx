// PrivateNote (COMPONENTS-profile-viewer.md §4 + COMPONENTS-dm-sidebar.md §3):
// the shared per-character private-note editor — three states (none / peek /
// editor), inline autosave, only-you-can-see. One component, used by both the
// profile viewer's Insights tab and the DM sidebar, so the note reads and
// writes identically in both places (one source of truth: the note rides the
// cached profile response and persists via the same debounced PUT).
//
// Save model: debounced save while typing (≈600ms) plus an immediate save on
// blur / Escape. The chip confirms — Saving… → ✓ Saved, or ⚠ Not saved on a
// failed write (the text is kept, never dropped). An editor left empty on blur
// deletes the record and returns to the None state.

import { useRef, useState } from "react";
import {
  saveNoteDebounced,
  saveNoteNow,
  type NoteSaveCallbacks,
} from "../../stores/profile.js";
import { api } from "../../lib/api.js";
import {
  nextNoteSaveState,
  noteSaveLabel,
  type NoteSaveState,
} from "./note-save.js";
import styles from "./profile.module.css";

export function PrivateNote({
  identityId,
  name,
  initial,
  fullWidth = false,
  escapeCollapses = false,
}: {
  identityId: string;
  name: string;
  initial: string | null;
  /** Fill the container width (DM sidebar) instead of the viewer's fixed
   * card width. */
  fullWidth?: boolean;
  /** Escape blurs (saving) and collapses to peek instead of bubbling up.
   * Used inline (DM sidebar); left off inside the profile modal, where
   * Escape must still close the window. */
  escapeCollapses?: boolean;
}) {
  const [mode, setMode] = useState<"idle" | "editing">("idle");
  const [body, setBody] = useState(initial ?? "");
  const [saveState, setSaveState] = useState<NoteSaveState>("idle");
  // Only the newest write may update the chip — a superseded save resolving
  // late must not flash ✓ over a fresher Saving… / ⚠.
  const reqRef = useRef(0);
  const dirtyRef = useRef(false);
  const fullClass = fullWidth ? (styles.noteFull ?? "") : "";

  function callbacks(token: number): NoteSaveCallbacks {
    return {
      onSaved: () => {
        if (reqRef.current === token) {
          setSaveState((s) => nextNoteSaveState(s, "saved"));
        }
      },
      onError: () => {
        if (reqRef.current === token) {
          setSaveState((s) => nextNoteSaveState(s, "error"));
        }
      },
    };
  }

  function edit(next: string) {
    setBody(next);
    dirtyRef.current = true;
    const token = ++reqRef.current;
    setSaveState((s) => nextNoteSaveState(s, "edit"));
    saveNoteDebounced(identityId, name, next, callbacks(token));
  }

  function flush() {
    if (!dirtyRef.current) {
      return;
    }
    dirtyRef.current = false;
    const token = ++reqRef.current;
    setSaveState((s) => nextNoteSaveState(s, "edit"));
    saveNoteNow(identityId, name, body, callbacks(token));
  }

  if (mode === "editing") {
    const chip = noteSaveLabel(saveState);
    return (
      <div className={`${styles.noteEditor} ${fullClass}`}>
        <span className={styles.noteEyebrow}>
          <span className={styles.noteDot} aria-hidden />
          PRIVATE NOTE
          {chip && (
            <span
              className={`${styles.noteSaved} ${saveState === "error" ? (styles.noteError ?? "") : ""}`}
              role="status"
            >
              {chip}
            </span>
          )}
        </span>
        <textarea
          className={styles.noteBody}
          value={body}
          autoFocus
          placeholder={`Anything you want to remember about ${name}…`}
          onChange={(event) => {
            edit(event.target.value);
          }}
          onKeyDown={(event) => {
            if (escapeCollapses && event.key === "Escape") {
              // Blur (which flushes the save) and collapse to peek, without
              // letting Escape bubble up to close a host surface (the DM
              // overlay drawer). In the profile modal this handler is off, so
              // Escape still closes the window.
              event.preventDefault();
              event.stopPropagation();
              event.currentTarget.blur();
              setMode("idle");
            }
          }}
          onBlur={() => {
            flush();
            if (body.trim() === "") {
              setMode("idle");
            }
          }}
        />
        <span className={styles.noteFoot}>
          autosaves · only you can see this
          {body === "" && (
            <>
              {" · "}
              <button
                type="button"
                className={styles.noteImport}
                onClick={() => {
                  void api
                    .getProfileMemo(identityId, name)
                    .then(({ note }) => {
                      if (note) {
                        edit(note);
                      }
                    })
                    .catch(() => {
                      // No memo / upstream trouble — best-effort affordance.
                    });
                }}
              >
                import F-List memo
              </button>
            </>
          )}
        </span>
      </div>
    );
  }

  if (body.trim() === "") {
    return (
      <button
        type="button"
        className={`${styles.noteAdd} ${fullClass}`}
        onClick={() => {
          setMode("editing");
        }}
      >
        + Add private note
      </button>
    );
  }

  return (
    <button
      type="button"
      className={`${styles.notePeek} ${fullClass}`}
      onClick={() => {
        setMode("editing");
      }}
    >
      <span className={styles.noteEyebrow}>
        <span className={styles.noteDot} aria-hidden />
        PRIVATE NOTE
        <span className={styles.notePencil} aria-hidden>
          ✎
        </span>
      </span>
      <span
        className={`${styles.notePreview} ${fullWidth ? (styles.notePreviewClamp ?? "") : ""}`}
      >
        {body}
      </span>
    </button>
  );
}
