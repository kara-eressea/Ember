// RateEditor popover (M11, COMPONENTS-rotation-ratings.md §7): ★ 1–5 + an
// optional private note, anchored below its trigger (§13 placement) in the
// PrivateNote editor language. Every surface repeats the local-only
// promise. Dismissal follows the HelpPanel pattern: capture-phase Escape
// and click-away, stopping propagation so stacked layers don't also close.

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Avatar } from "../common/Avatar.js";
import { StarPicker } from "./StarRating.js";
import { placePopover } from "../profile/popover.js";
import { ratingFor, useRatingsStore } from "../../stores/ratings.js";
import { useEscapeToClose } from "../../lib/useEscapeToClose.js";
import styles from "./ratings.module.css";

const EDITOR_WIDTH = 260;
const EDITOR_HEIGHT = 268;

export function RateEditor({
  character,
  anchor,
  onClose,
}: {
  character: string;
  anchor: DOMRect;
  onClose: () => void;
}) {
  const byName = useRatingsStore((s) => s.byName);
  const existing = ratingFor(byName, character);
  const [score, setScore] = useState(existing?.score ?? 0);
  const [note, setNote] = useState(existing?.note ?? "");
  const [saved, setSaved] = useState(false);
  const [failed, setFailed] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  /** Armed on Clear's pointerdown so the note field's blur-save can't
   * race the delete and resurrect the rating. */
  const clearingRef = useRef(false);

  // Escape dismissal rides the shared overlay stack so the editor (topmost
  // when open above a mini-card) closes first and claims the event.
  useEscapeToClose(onClose);
  useEffect(() => {
    function onPointer(event: PointerEvent) {
      if (ref.current && !ref.current.contains(event.target as Node)) {
        onClose();
      }
    }
    window.addEventListener("pointerdown", onPointer, true);
    return () => {
      window.removeEventListener("pointerdown", onPointer, true);
    };
  }, [onClose]);

  const placement = placePopover(
    anchor,
    { width: EDITOR_WIDTH, height: EDITOR_HEIGHT },
    { width: window.innerWidth, height: window.innerHeight },
  );

  async function save(nextScore: number, nextNote: string) {
    const ok = await useRatingsStore
      .getState()
      .save(
        character,
        nextScore,
        nextNote.trim() === "" ? undefined : nextNote.trim(),
      );
    setSaved(ok);
    setFailed(!ok);
  }

  // Portaled to <body>: the ad-row mount sits inside a transformed
  // virtualizer row, which would otherwise become the containing block
  // for this fixed-position popover (audit HIGH).
  return createPortal(
    <div
      ref={ref}
      className={styles.editor}
      role="dialog"
      aria-label={`Rate ${character}`}
      style={{ top: placement.top, left: placement.left }}
    >
      <div className={styles.editorHead}>
        <Avatar name={character} size={26} />
        <span className={styles.editorWho}>
          <span className={styles.editorNick}>{character}</span>
          <span className={styles.editorScope}>
            shared across your characters
          </span>
        </span>
      </div>
      <div className={styles.editorBody}>
        <div className={styles.editorEyebrowRow}>
          <span className={styles.editorEyebrow}>Rate this poster</span>
          {saved && <span className={styles.savedMark}>Saved ✓</span>}
          {failed && (
            <span className={styles.failedMark}>Couldn't save — try again</span>
          )}
        </div>
        <div className={styles.pickerRow}>
          <StarPicker
            score={score}
            onPick={(next) => {
              setScore(next);
              setSaved(false);
              void save(next, note);
            }}
          />
          {score > 0 ? (
            <span className={styles.pickerScore}>{score}/5</span>
          ) : (
            <span className={styles.pickerHint}>tap to rate</span>
          )}
        </div>
        <textarea
          className={styles.noteField}
          value={note}
          rows={3}
          placeholder="Add a private note (optional)…"
          aria-label="Private note"
          onChange={(event) => {
            setNote(event.target.value);
            setSaved(false);
          }}
          onBlur={() => {
            if (score > 0 && !clearingRef.current) {
              void save(score, note);
            }
          }}
        />
        <div className={styles.promise}>
          <span className={styles.promiseDot} aria-hidden />
          saved on this server only · never sent to F-List
        </div>
        {existing !== undefined && (
          <div className={styles.clearRow}>
            <button
              type="button"
              className={styles.clearButton}
              onPointerDown={() => {
                clearingRef.current = true;
              }}
              onClick={() => {
                void useRatingsStore.getState().clear(character);
                onClose();
              }}
            >
              Clear rating
            </button>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
