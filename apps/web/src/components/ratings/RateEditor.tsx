// RateEditor popover (M11, COMPONENTS-rotation-ratings.md §7): ★ 1–5 + an
// optional private note, anchored below its trigger (§13 placement) in the
// PrivateNote editor language. Every surface repeats the local-only
// promise. Dismissal follows the HelpPanel pattern: capture-phase Escape
// and click-away, stopping propagation so stacked layers don't also close.

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Avatar } from "../common/Avatar.js";
import { StarPicker } from "./StarRating.js";
import {
  placePopoverInWindow,
  popoverWidthInWindow,
} from "../profile/popover.js";
import { liveAnchor, type CardAnchor } from "../../stores/profile.js";
import { ratingFor, useRatingsStore } from "../../stores/ratings.js";
import { useEscapeToClose } from "../../lib/useEscapeToClose.js";
import styles from "./ratings.module.css";

const EDITOR_WIDTH = 260;
const EDITOR_HEIGHT = 268;

export function RateEditor({
  character,
  anchor,
  anchorElement,
  onClose,
}: {
  character: string;
  /** Where the trigger was when the editor opened — the first frame's
   * placement, and the fallback for a trigger that was never handed over. */
  anchor: CardAnchor;
  /** The trigger itself, re-measured as the log scrolls under the editor. */
  anchorElement?: Element;
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

  // Follow the trigger (#284, #560), the way MiniProfileCard does: this editor
  // opens on an ad row inside the virtualized log, which auto-scrolls behind it
  // as messages arrive — so the rect captured at click time is stale by the
  // next line, and the row can be virtualized away entirely while the editor is
  // still on screen.
  //
  // The editor's box is a constant, so unlike the mini card it never has to
  // measure itself after rendering: the only inputs are the trigger's rect and
  // the viewport, and both change only when something scrolls or resizes. One
  // placement at mount, then one per frame that moves it.
  const measure = useCallback(
    (rect: CardAnchor) =>
      placePopoverInWindow(rect, {
        // The width CSS actually drew, which on a narrow phone is the viewport
        // cap rather than EDITOR_WIDTH (MP1 §5-E).
        width: popoverWidthInWindow(EDITOR_WIDTH),
        height: EDITOR_HEIGHT,
      }),
    [],
  );
  const [placement, setPlacement] = useState(() =>
    measure(liveAnchor(anchorElement) ?? anchor),
  );

  useEffect(() => {
    let frame = 0;
    function place() {
      frame = 0;
      const live = liveAnchor(anchorElement);
      if (anchorElement && !live) {
        // The trigger left the document (virtualized away, conversation
        // switched) — close rather than float at stale coordinates over an
        // unrelated message.
        onClose();
        return;
      }
      const next = measure(live ?? anchor);
      // Only commit a placement that actually moved: this runs on every scroll
      // frame, and a fresh object each time would re-render the editor — and
      // the note field the user is typing in — sixty times a second.
      setPlacement((prev) =>
        prev.top === next.top && prev.left === next.left ? prev : next,
      );
    }
    function schedule() {
      frame ||= requestAnimationFrame(place);
    }
    // Capture phase, so the log's own scroller counts and not just the window;
    // resize matters for the viewport clamp.
    window.addEventListener("scroll", schedule, true);
    window.addEventListener("resize", schedule);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("scroll", schedule, true);
      window.removeEventListener("resize", schedule);
    };
  }, [anchor, anchorElement, measure, onClose]);

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
      data-eb-surface
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
