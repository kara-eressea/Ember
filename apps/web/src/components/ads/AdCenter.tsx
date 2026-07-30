// Ad Center (M10 step 5, COMPONENTS-ad-center-search.md §2): the
// per-character ad library. Master–detail modal in the Preferences-window
// language — library column (order = post order) + editor pane with live
// preview, a hard-capped byte counter against the live ad limit, advisory
// lossiness warnings, and free-form tag chips. Every save replaces the full
// list (REST PUT, knownIds compare-and-set); a 409 surfaces as a
// reload-and-review banner that never discards the unsaved draft.

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { analyzeMarkdown, mdToBBCode } from "@emberchat/markdown-bbcode";
import {
  MAX_ADS_PER_IDENTITY,
  MAX_AD_TAGS,
  MAX_AD_TAG_LENGTH,
  type AdDto,
} from "@emberchat/protocol";
import { api, ApiError } from "../../lib/api.js";
import { knownIdsFor, useAdsStore } from "../../stores/ads.js";
import type { IdentitySession } from "../../stores/sessions.js";
import { useUiStore } from "../../stores/ui.js";
import { RichText } from "../chat/RichText.js";
import {
  adTitle,
  commitTag,
  counterLevel,
  lineOfOffset,
  LOSSINESS_COPY,
  movedSelection,
  reorder,
  stripModel,
} from "./ad-center-logic.js";
import styles from "./ads.module.css";

const utf8 = new TextEncoder();

interface Draft {
  content: string;
  tags: string[];
  disabled: boolean;
}

const EMPTY_DRAFT: Draft = { content: "", tags: [], disabled: false };

function draftOf(ad: AdDto): Draft {
  return { content: ad.content, tags: ad.tags, disabled: ad.disabled };
}

export function AdCenter({
  session,
  onClose,
}: {
  session: IdentitySession;
  onClose: () => void;
}) {
  const identityId = session.identityId;
  const entry = useAdsStore((state) => state.byIdentity[identityId]);
  const ads = useMemo(() => entry?.ads ?? [], [entry]);
  /** Row index being edited, "new" for an unsaved ad, undefined = none. */
  const [selected, setSelected] = useState<number | "new">();
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [baseline, setBaseline] = useState<Draft>(EMPTY_DRAFT);
  const [tagText, setTagText] = useState("");
  const [conflict, setConflict] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [loadError, setLoadError] = useState(false);
  const dragFrom = useRef<number>(undefined);
  const windowRef = useRef<HTMLDivElement>(null);
  /** First close attempt with a dirty draft warns instead of discarding;
   * the next one closes. Any edit re-arms the warning. */
  const closeArmed = useRef(false);
  /** The library the open editor's row index is based on — re-based on
   * select and on every list we wrote ourselves. The store holding a
   * DIFFERENT array means another device saved: every index into the old
   * list is suspect, so the conflict banner shows and Save is disabled
   * until Reload re-bases. */
  const [baseAds, setBaseAds] = useState<AdDto[]>();

  const dirty =
    selected !== undefined &&
    (draft.content !== baseline.content ||
      draft.disabled !== baseline.disabled ||
      draft.tags.join("\n") !== baseline.tags.join("\n"));

  // The ad limit is the live server VAR; the counter measures the translated
  // wire form — that is what the server checks, and it is usually longer
  // than the Markdown that was typed.
  const wire = mdToBBCode(draft.content);
  const bytes = utf8.encode(wire).length;
  const limit = session.limits.lfrpMax;
  const level = counterLevel(bytes, limit);
  const diags = useMemo(() => analyzeMarkdown(draft.content), [draft.content]);
  const strip = stripModel(diags);

  useEffect(() => {
    windowRef.current?.focus();
  }, []);

  function guardedClose() {
    if (dirty && !closeArmed.current) {
      closeArmed.current = true;
      setError("Unsaved changes — close again to discard them");
      return;
    }
    onClose();
  }

  useEffect(() => {
    function onKey(event: globalThis.KeyboardEvent) {
      if (event.key === "Escape") {
        if (dirty && !closeArmed.current) {
          closeArmed.current = true;
          setError("Unsaved changes — press Escape again to discard them");
          return;
        }
        onClose();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose, dirty]);

  const externalChange =
    typeof selected === "number" && baseAds !== undefined && ads !== baseAds;
  const showConflict = conflict || externalChange;

  useEffect(() => {
    if (entry?.loaded) {
      return;
    }
    let cancelled = false;
    api
      .getAds(identityId)
      .then((response) => {
        if (!cancelled) {
          useAdsStore.getState().applyAds(identityId, response.ads);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setLoadError(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [identityId, entry?.loaded]);

  function select(index: number | "new") {
    // Switching rows drops any unsaved edit — the footer said "Unsaved
    // changes" while it mattered, and the library list stays authoritative.
    const next = index === "new" ? EMPTY_DRAFT : draftOf(ads[index]!);
    setSelected(index);
    setDraft(next);
    setBaseline(next);
    setTagText("");
    setError(undefined);
    setBaseAds(ads);
    closeArmed.current = false;
  }

  function setContent(value: string) {
    // Hard cap (COMPONENTS §2c): at the limit the field stops accepting
    // input — an over-long ad can never exist, so it is never truncated.
    const nextBytes = utf8.encode(mdToBBCode(value)).length;
    if (nextBytes > limit && nextBytes > bytes) {
      return;
    }
    setDraft((d) => ({ ...d, content: value }));
  }

  /** PUTs a full replacement list; true on success. 409 → conflict banner. */
  async function putList(
    list: { content: string; tags: string[]; disabled: boolean }[],
  ): Promise<AdDto[] | undefined> {
    setBusy(true);
    setError(undefined);
    try {
      const response = await api.putAds(
        identityId,
        list,
        knownIdsFor(identityId),
      );
      useAdsStore.getState().applyAds(identityId, response.ads);
      setBaseAds(response.ads);
      setConflict(false);
      return response.ads;
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setConflict(true);
      } else {
        setError(err instanceof Error ? err.message : "Saving failed");
      }
      return undefined;
    } finally {
      setBusy(false);
    }
  }

  function inputsFrom(list: AdDto[]) {
    return list.map((ad) => ({
      content: ad.content,
      tags: ad.tags,
      disabled: ad.disabled,
    }));
  }

  async function save() {
    if (draft.content.trim() === "" || busy) {
      return;
    }
    const list = inputsFrom(ads);
    const mine = { ...draft, tags: draft.tags };
    const savedIndex = selected === "new" ? list.length : (selected ?? 0);
    if (selected === "new") {
      list.push(mine);
    } else if (typeof selected === "number") {
      list[selected] = mine;
    }
    const saved = await putList(list);
    if (saved) {
      // Reselect from the RESPONSE list — the closure's `ads` is the
      // pre-save render's value (empty on the very first save).
      const index = Math.min(savedIndex, saved.length - 1);
      const ad = index >= 0 ? saved[index] : undefined;
      if (ad) {
        const next = draftOf(ad);
        setSelected(index);
        setDraft(next);
        setBaseline(next);
        setTagText("");
        setError(undefined);
      } else {
        setSelected(undefined);
      }
    }
  }

  async function removeAd(index: number) {
    // externalChange: the open editor's index is based on an older list —
    // mutating rows now would re-base it under a stale selection. The
    // banner directs to Reload first.
    if (busy || externalChange) {
      return;
    }
    const list = inputsFrom(ads);
    list.splice(index, 1);
    const saved = await putList(list);
    if (saved && typeof selected === "number") {
      if (selected === index) {
        setSelected(undefined);
      } else if (selected > index) {
        // The rows above the deleted one shift down — follow the same ad.
        setSelected(selected - 1);
      }
    }
  }

  async function toggleRowDisabled(index: number) {
    if (busy || externalChange) {
      return;
    }
    const list = inputsFrom(ads);
    list[index] = { ...list[index]!, disabled: !list[index]!.disabled };
    const saved = await putList(list);
    if (saved && selected === index) {
      setDraft((d) => ({ ...d, disabled: !d.disabled }));
      setBaseline((b) => ({ ...b, disabled: !b.disabled }));
    }
  }

  async function moveAd(from: number, to: number) {
    if (busy || externalChange || to < 0 || to >= ads.length || from === to) {
      return;
    }
    const saved = await putList(inputsFrom(reorder(ads, from, to)));
    if (saved && typeof selected === "number") {
      setSelected(movedSelection(selected, from, to));
    }
  }

  function dropOn(index: number) {
    const from = dragFrom.current;
    dragFrom.current = undefined;
    if (from !== undefined) {
      void moveAd(from, index);
    }
  }

  async function reload() {
    try {
      const response = await api.getAds(identityId);
      useAdsStore.getState().applyAds(identityId, response.ads);
      setBaseAds(response.ads);
      setConflict(false);
      // The old row index means nothing against the reloaded list: a kept
      // draft re-targets as a new ad (saving appends, nothing is lost); a
      // clean editor just closes.
      if (typeof selected === "number") {
        setSelected(dirty ? "new" : undefined);
      }
    } catch {
      setError("Couldn't reload the library — try again");
    }
  }

  function onTagKey(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter" || event.key === ",") {
      event.preventDefault();
      const next = commitTag(draft.tags, tagText);
      if (next !== draft.tags) {
        setDraft((d) => ({ ...d, tags: next }));
        setTagText("");
      }
    } else if (
      event.key === "Backspace" &&
      tagText === "" &&
      draft.tags.length > 0
    ) {
      setDraft((d) => ({ ...d, tags: d.tags.slice(0, -1) }));
    }
  }

  const counter = (
    <span className={styles.counter} data-level={level}>
      <span className={styles.counterTrack}>
        <span
          className={styles.counterFill}
          style={{ width: `${String(Math.min(100, (bytes / limit) * 100))}%` }}
        />
      </span>
      <span className={styles.counterCount}>
        {bytes.toLocaleString()} / {limit.toLocaleString()}
      </span>
      {level === "cap" && <span className={styles.counterCap}>at limit</span>}
    </span>
  );

  const editor = selected !== undefined && (
    <>
      <div className={styles.paneHead}>
        <h2 className={styles.paneTitle}>
          {selected === "new" ? "New ad" : "Edit ad"}
        </h2>
        <label className={styles.disabledToggle}>
          <span className={styles.disabledText}>
            <span className={styles.disabledLabel}>Disabled</span>
            <span className={styles.disabledHint}>
              kept, skipped when posting
            </span>
          </span>
          <input
            type="checkbox"
            checked={draft.disabled}
            onChange={() => {
              setDraft((d) => ({ ...d, disabled: !d.disabled }));
            }}
          />
        </label>
      </div>
      {showConflict && (
        <div className={styles.conflict} role="alert">
          <div className={styles.conflictBody}>
            <strong>Your ads changed on another device</strong>
            <span>
              Reload to review the current library — the text below is kept so
              nothing you wrote is lost.
            </span>
          </div>
          <button
            type="button"
            className={styles.conflictReload}
            onClick={() => {
              void reload();
            }}
          >
            Reload
          </button>
        </div>
      )}
      <div className={styles.editorBody}>
        <div className={styles.field}>
          <div className={styles.fieldHead}>
            <span className={styles.fieldLabel}>Markdown</span>
            {counter}
          </div>
          <textarea
            className={styles.fieldInput}
            value={draft.content}
            rows={6}
            placeholder="Write the ad — same Markdown as the composer"
            aria-label="Ad text"
            onChange={(event) => {
              setContent(event.target.value);
            }}
          />
        </div>
        {strip.visible.length > 0 && (
          <div className={styles.lossiness}>
            <div className={styles.lossinessHead}>
              <span>
                {diags.length === 1
                  ? "1 part will post as plain text"
                  : `${String(diags.length)} parts will post as plain text`}
              </span>
              <span className={styles.lossinessNote}>
                just a heads-up · saving still works
              </span>
            </div>
            {strip.visible.map((diag, i) => (
              <div key={i} className={styles.lossinessRow}>
                <span className={styles.lossinessGlyph} aria-hidden>
                  ⚠
                </span>
                <span className={styles.lossinessText}>
                  <span className={styles.lossinessLabel}>
                    {LOSSINESS_COPY[diag.kind].label}
                  </span>
                  <span className={styles.lossinessCopy}>
                    {LOSSINESS_COPY[diag.kind].copy}
                  </span>
                  {diag.snippet.trim() !== "" && (
                    <code className={styles.lossinessSnippet}>
                      {diag.snippet}
                    </code>
                  )}
                </span>
                <span className={styles.lossinessLine}>
                  L{lineOfOffset(draft.content, diag.at)}
                </span>
              </div>
            ))}
            {strip.overflow > 0 && (
              <div className={styles.lossinessMore}>
                +{strip.overflow} more…
              </div>
            )}
          </div>
        )}
        {draft.content.trim() !== "" && (
          <div className={styles.preview}>
            <div className={styles.previewHead}>
              <span>Preview · as posted</span>
              <span className={styles.previewNote}>what the channel sees</span>
            </div>
            <div className={styles.previewBody}>
              <RichText bbcode={wire} local />
            </div>
          </div>
        )}
        <div className={styles.field}>
          <div className={styles.fieldHead}>
            <span className={styles.fieldLabel}>Tags</span>
            <span className={styles.fieldNote}>
              yours only · posting picks an ad by tag
            </span>
          </div>
          <div className={styles.tagField}>
            {draft.tags.map((tag) => (
              <span key={tag} className={styles.tagChip}>
                {tag}
                <button
                  type="button"
                  className={styles.tagRemove}
                  aria-label={`Remove tag ${tag}`}
                  onClick={() => {
                    setDraft((d) => ({
                      ...d,
                      tags: d.tags.filter((t) => t !== tag),
                    }));
                  }}
                >
                  ✕
                </button>
              </span>
            ))}
            <input
              className={styles.tagInput}
              value={tagText}
              placeholder={draft.tags.length >= MAX_AD_TAGS ? "" : "add tag…"}
              disabled={draft.tags.length >= MAX_AD_TAGS}
              maxLength={MAX_AD_TAG_LENGTH}
              aria-label="Add tag"
              onChange={(event) => {
                setTagText(event.target.value);
              }}
              onKeyDown={onTagKey}
            />
          </div>
          <p className={styles.fieldHint}>
            Up to {MAX_AD_TAGS} tags, {MAX_AD_TAG_LENGTH} characters each. An ad
            with no tags is filed under <code>default</code>.
          </p>
        </div>
      </div>
      <div className={styles.editorFooter}>
        <span className={styles.dirtyState}>
          {error ?? (dirty ? "Unsaved changes" : "Saved")}
        </span>
        <span className={styles.footerButtons}>
          <button
            type="button"
            className={styles.button}
            onClick={() => {
              setSelected(undefined);
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            className={styles.buttonPrimary}
            disabled={
              busy || showConflict || draft.content.trim() === "" || !dirty
            }
            onClick={() => {
              void save();
            }}
          >
            Save ad
          </button>
        </span>
      </div>
    </>
  );

  const emptyPane = (
    <div className={styles.empty}>
      <div className={styles.emptyGlyph} aria-hidden>
        ✎
      </div>
      <h2 className={styles.emptyTitle}>Write an ad once, post it anywhere</h2>
      <p className={styles.emptyCopy}>
        Your roleplay ads live here. Write them in the composer's Markdown, tag
        them however you like, then post the one you pick to the channels you
        choose — nothing ever posts on its own.
      </p>
      <button
        type="button"
        className={styles.buttonPrimary}
        onClick={() => {
          select("new");
        }}
      >
        Write your first ad
      </button>
    </div>
  );

  return (
    <div
      className={styles.overlay}
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) {
          guardedClose();
        }
      }}
    >
      <div
        className={styles.window}
        role="dialog"
        aria-modal="true"
        aria-label="Ad Center"
        tabIndex={-1}
        ref={windowRef}
      >
        <div className={styles.library}>
          <div className={styles.libraryHead}>
            <div className={styles.libraryTitleRow}>
              <span className={styles.libraryTitle}>Ad Center</span>
              <span className={styles.libraryCap}>
                {ads.length} / {MAX_ADS_PER_IDENTITY}
              </span>
            </div>
            <span className={styles.libraryIdentity}>
              as {session.character}
            </span>
          </div>
          <div className={styles.libraryList}>
            {loadError && (
              <p className={styles.libraryError}>
                Couldn't load your ads — close and try again.
              </p>
            )}
            {ads.map((ad, index) => (
              <div
                key={ad.id}
                className={`${styles.adRow} ${index === selected ? (styles.adRowActive ?? "") : ""} ${ad.disabled ? (styles.adRowDisabled ?? "") : ""}`}
                draggable
                onDragStart={() => {
                  dragFrom.current = index;
                }}
                onDragOver={(event) => {
                  event.preventDefault();
                }}
                onDrop={() => {
                  dropOn(index);
                }}
                onClick={() => {
                  select(index);
                }}
              >
                <span className={styles.adGrip} aria-hidden>
                  ⁝⁝
                </span>
                <button
                  type="button"
                  className={styles.adRowBody}
                  title="Open to edit · Alt+↑/↓ moves this ad"
                  aria-label={`Edit ad: ${adTitle(ad.content)}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    select(index);
                  }}
                  onKeyDown={(event) => {
                    if (event.altKey && event.key === "ArrowUp") {
                      event.preventDefault();
                      void moveAd(index, index - 1);
                    } else if (event.altKey && event.key === "ArrowDown") {
                      event.preventDefault();
                      void moveAd(index, index + 1);
                    }
                  }}
                >
                  <span className={styles.adRowTitleLine}>
                    <span className={styles.adRowTitle}>
                      {adTitle(ad.content)}
                    </span>
                    {ad.disabled && <span className={styles.adOff}>off</span>}
                  </span>
                  {ad.tags.length > 0 && (
                    <span className={styles.adRowTags}>
                      {ad.tags.map((tag) => (
                        <span key={tag} className={styles.adRowTag}>
                          {tag}
                        </span>
                      ))}
                    </span>
                  )}
                </button>
                <span className={styles.adRowActions}>
                  <button
                    type="button"
                    className={styles.adAction}
                    title={ad.disabled ? "Enable this ad" : "Disable this ad"}
                    aria-label={
                      ad.disabled ? "Enable this ad" : "Disable this ad"
                    }
                    onClick={(event) => {
                      event.stopPropagation();
                      void toggleRowDisabled(index);
                    }}
                  >
                    {ad.disabled ? "▷" : "◫"}
                  </button>
                  <button
                    type="button"
                    className={`${styles.adAction} ${styles.adDelete ?? ""}`}
                    title="Delete this ad"
                    aria-label="Delete this ad"
                    onClick={(event) => {
                      event.stopPropagation();
                      void removeAd(index);
                    }}
                  >
                    ✕
                  </button>
                </span>
              </div>
            ))}
          </div>
          <div className={styles.libraryFoot}>
            <button
              type="button"
              className={styles.newAd}
              disabled={ads.length >= MAX_ADS_PER_IDENTITY}
              onClick={() => {
                select("new");
              }}
            >
              + New ad
            </button>
            <button
              type="button"
              className={styles.postAds}
              disabled={ads.every((ad) => ad.disabled)}
              onClick={() => {
                useUiStore.getState().setPostAdsOpen(true);
              }}
            >
              Post ads…
            </button>
          </div>
        </div>
        <section className={styles.pane}>
          {selected !== undefined ? (
            editor
          ) : ads.length === 0 ? (
            emptyPane
          ) : (
            <div className={styles.empty}>
              <p className={styles.emptyCopy}>
                Pick an ad to edit, or write a new one.
              </p>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
