// Character search (M10 step 9, COMPONENTS-ad-center-search.md §6): the
// FKS dialog beside the channel browser. Kinks are required by the wire
// (ids as strings); genders/orientation/role/languages/furry preference are
// optional narrowing filters. The server paces searches at one per five
// seconds — the button waits it out visibly. Results are bare names; the
// text box narrows them client-side, the MatchTier chip appears cache-only,
// and a click opens the mini profile card. Saved searches sync their filter
// definitions through prefs; the "N new" badge diffs against this device's
// previous run.

import { useEffect, useMemo, useRef, useState } from "react";
import { gateway } from "../../gateway/socket.js";
import { api } from "../../lib/api.js";
import { openCardFrom } from "../../stores/profile.js";
import { useSearchStore } from "../../stores/search.js";
import type { IdentitySession } from "../../stores/sessions.js";
import { nickColor } from "../../theme/tokens.js";
import { Avatar } from "../common/Avatar.js";
import { CachedMatchChip } from "../profile/CachedMatchChip.js";
import { patchPrefs } from "../prefs/patch.js";
import {
  FURRYPREF_LABELS,
  FURRYPREFS,
  filterNames,
  filtersOf,
  GENDERS,
  LANGUAGES,
  loadRun,
  newSince,
  normalizeFilters,
  ORIENTATIONS,
  ROLES,
  saveRun,
  savedMeta,
  dropRun,
  type SavedSearch,
  type SearchFilters,
} from "./search-logic.js";
import styles from "./search.module.css";

const PACE_MS = 5000;
/** Client-side stuck-search backstop: the server's own reply window is
 * 5 s pace hold + 10 s wait, so anything past this is a lost reply. */
const WATCHDOG_MS = 20_000;

interface KinkEntry {
  id: string;
  name: string;
  group?: string;
}

/** Vocabulary cache — one fetch per app session, the list changes on a
 * week-scale TTL server-side. */
let kinkCache: KinkEntry[] | undefined;

export function CharacterSearch({
  session,
  onClose,
}: {
  session: IdentitySession;
  onClose: () => void;
}) {
  const identityId = session.identityId;
  const online = session.sessionStatus === "online";
  const state = useSearchStore((s) => s.byIdentity[identityId]);
  const savedSearches = session.prefs.savedSearches;

  const [vocab, setVocab] = useState<KinkEntry[] | undefined>(kinkCache);
  const [vocabError, setVocabError] = useState(false);
  const [kinks, setKinks] = useState<string[]>([]);
  const [genders, setGenders] = useState<string[]>([]);
  const [orientations, setOrientations] = useState<string[]>([]);
  const [languages, setLanguages] = useState<string[]>([]);
  const [furryprefs, setFurryprefs] = useState<string[]>([]);
  const [roles, setRoles] = useState<string[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerQuery, setPickerQuery] = useState("");
  const [nameFilter, setNameFilter] = useState("");
  const [activeSavedId, setActiveSavedId] = useState<string>();
  const [savingName, setSavingName] = useState<string>();
  const [newCounts, setNewCounts] = useState<Record<string, number>>({});
  const [now, setNow] = useState(() => Date.now());
  /** Which saved search the in-flight run belongs to (badge bookkeeping). */
  const firedForRef = useRef<string | undefined>(undefined);
  const lastSeenResultsRef = useRef<string[] | undefined>(undefined);
  const windowRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    windowRef.current?.focus();
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onClose();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  useEffect(() => {
    if (vocab !== undefined) {
      return;
    }
    let cancelled = false;
    api
      .getKinks(identityId)
      .then((response) => {
        kinkCache = response.kinks;
        if (!cancelled) {
          setVocab(response.kinks);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setVocabError(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [identityId, vocab]);

  // Cooldown clock — ticks only while a pace window is open.
  const sinceSearch = now - (state?.lastSearchAt ?? 0);
  const coolingMs = Math.max(0, PACE_MS - sinceSearch);
  const cooling = coolingMs > 0 || state?.searching === true;
  useEffect(() => {
    if (!cooling) {
      return;
    }
    const timer = setInterval(() => {
      setNow(Date.now());
    }, 500);
    return () => {
      clearInterval(timer);
    };
  }, [cooling]);

  // Saved-search badge: when the results of a fired saved search land,
  // diff against this device's previous run and remember the new set.
  const results = state?.results;
  useEffect(() => {
    if (results === undefined || results === lastSeenResultsRef.current) {
      return;
    }
    lastSeenResultsRef.current = results;
    const savedId = firedForRef.current;
    firedForRef.current = undefined;
    if (savedId === undefined) {
      return;
    }
    const previous = loadRun(savedId);
    if (previous) {
      setNewCounts((counts) => ({
        ...counts,
        [savedId]: newSince(previous.names, results),
      }));
    }
    saveRun(savedId, results);
  }, [results]);

  const filters: SearchFilters = normalizeFilters({
    kinks,
    genders,
    orientations,
    languages,
    furryprefs,
    roles,
  });

  function fire(toRun: SearchFilters, savedId?: string) {
    if (!online || toRun.kinks.length === 0 || state?.searching === true) {
      return;
    }
    firedForRef.current = savedId;
    // beginSearch stamps lastSearchAt; the cooldown effect's interval
    // brings `now` forward, so no clock read is needed here.
    const firedAt = useSearchStore.getState().beginSearch(identityId);
    // The reply event goes only to the gateway connection that asked — a
    // refused command or a socket blip mid-search would otherwise leave
    // "Searching…" stuck forever. The watchdog only fires if this exact
    // search is still marked in flight.
    void gateway
      .cmd({
        identityId,
        action: "character.search",
        d: toRun,
      })
      .then((ack) => {
        if (!ack.ok) {
          useSearchStore
            .getState()
            .failSearch(
              identityId,
              firedAt,
              ack.error ?? "The search couldn't start — try again",
            );
        }
      });
    setTimeout(() => {
      useSearchStore
        .getState()
        .failSearch(
          identityId,
          firedAt,
          "The search didn't come back — try again",
        );
    }, WATCHDOG_MS);
  }

  function applySaved(saved: SavedSearch) {
    setActiveSavedId(saved.id);
    setKinks(saved.kinks);
    setGenders(saved.genders ?? []);
    setOrientations(saved.orientations ?? []);
    setLanguages(saved.languages ?? []);
    setFurryprefs(saved.furryprefs ?? []);
    setRoles(saved.roles ?? []);
    // Same gate as the footer button: never fire over an in-flight search
    // (its results would be credited to this saved search's "new" badge).
    if (coolingMs <= 0 && state?.searching !== true) {
      fire(filtersOf(saved), saved.id);
    }
  }

  function saveCurrent(name: string) {
    const trimmed = name.trim().slice(0, 60);
    if (trimmed === "" || kinks.length === 0 || savedSearches.length >= 12) {
      setSavingName(undefined);
      return;
    }
    const entry: SavedSearch = {
      id: crypto.randomUUID(),
      name: trimmed,
      ...filters,
    };
    void patchPrefs(identityId, {
      savedSearches: [...savedSearches, entry],
    });
    setActiveSavedId(entry.id);
    setSavingName(undefined);
    if (results !== undefined) {
      saveRun(entry.id, results);
    }
  }

  function removeSaved(saved: SavedSearch) {
    void patchPrefs(identityId, {
      savedSearches: savedSearches.filter((entry) => entry.id !== saved.id),
    });
    dropRun(saved.id);
    if (activeSavedId === saved.id) {
      setActiveSavedId(undefined);
    }
  }

  function toggle(
    values: string[],
    set: (next: string[]) => void,
    value: string,
  ) {
    set(
      values.includes(value)
        ? values.filter((entry) => entry !== value)
        : [...values, value],
    );
    setActiveSavedId(undefined);
  }

  const kinkById = useMemo(
    () => new Map((vocab ?? []).map((entry) => [entry.id, entry])),
    [vocab],
  );
  const pickerMatches = useMemo(() => {
    const q = pickerQuery.trim().toLowerCase();
    const list = vocab ?? [];
    return (
      q === ""
        ? list
        : list.filter((entry) => entry.name.toLowerCase().includes(q))
    ).slice(0, 60);
  }, [vocab, pickerQuery]);

  const shownNames = useMemo(
    () => filterNames(results ?? [], nameFilter),
    [results, nameFilter],
  );

  const refusal = state?.refusal;
  const searching = state?.searching === true;
  const canSearch = online && kinks.length > 0 && !searching && coolingMs <= 0;

  const filterGroup = (
    label: string,
    options: readonly string[],
    values: string[],
    set: (next: string[]) => void,
    labels?: Record<string, string>,
  ) => (
    <div className={styles.filterGroup}>
      <span className={styles.filterLabel}>{label}</span>
      <span className={styles.filterChips}>
        {options.map((option) => (
          <button
            key={option}
            type="button"
            className={`${styles.filterChip} ${values.includes(option) ? (styles.filterChipOn ?? "") : ""}`}
            aria-pressed={values.includes(option)}
            title={option}
            onClick={() => {
              toggle(values, set, option);
            }}
          >
            {labels?.[option] ?? option}
          </button>
        ))}
      </span>
    </div>
  );

  const emptyTile = (glyph: string, title: string, copy: string) => (
    <div className={styles.emptyTile}>
      <div className={styles.emptyGlyph} aria-hidden>
        {glyph}
      </div>
      <div className={styles.emptyTitle}>{title}</div>
      <p className={styles.emptyCopy}>{copy}</p>
    </div>
  );

  let resultsPane;
  if (refusal) {
    resultsPane =
      refusal.code === 18
        ? emptyTile(
            "∅",
            "No characters found",
            "No one online matched this search. Loosen the optional filters or drop a kink, then search again.",
          )
        : refusal.code === 72
          ? emptyTile(
              "⊞",
              "Too many results",
              "The server capped this search — add another kink or a filter to narrow it, then search again.",
            )
          : refusal.code === 61
            ? emptyTile(
                "⊞",
                "Too many search terms",
                "That's more filtering than the server accepts — drop a few selections and try again.",
              )
            : emptyTile("◷", "Not right now", refusal.message);
  } else if (results !== undefined) {
    resultsPane = (
      <div className={styles.resultsPane}>
        <div className={styles.resultsBar}>
          <input
            className={styles.nameFilter}
            value={nameFilter}
            placeholder="Filter these names…"
            aria-label="Filter result names"
            onChange={(event) => {
              setNameFilter(event.target.value);
            }}
          />
          <span className={styles.resultsCount} aria-live="polite">
            {shownNames.length === results.length
              ? `${String(results.length)} online`
              : `${String(shownNames.length)} of ${String(results.length)}`}
          </span>
        </div>
        <div className={styles.resultsList}>
          {shownNames.map((name) => (
            <button
              key={name}
              type="button"
              className={styles.resultRow}
              onClick={(event) => {
                openCardFrom(event.currentTarget, name);
              }}
            >
              <Avatar name={name} size={30} />
              <span
                className={styles.resultName}
                style={{ color: nickColor(name) }}
              >
                {name}
              </span>
              <CachedMatchChip name={name} />
              <span className={styles.onlineDot} aria-hidden />
            </button>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div
      className={styles.overlay}
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div
        className={styles.window}
        role="dialog"
        aria-modal="true"
        aria-label="Search characters"
        tabIndex={-1}
        ref={windowRef}
      >
        <div className={styles.rail}>
          <div className={styles.railTitle}>Saved searches</div>
          <div className={styles.railList}>
            {savedSearches.length === 0 && (
              <p className={styles.railEmpty}>
                Save a search and rerun it with one click.
              </p>
            )}
            {savedSearches.map((saved) => (
              <div
                key={saved.id}
                className={`${styles.savedRow} ${saved.id === activeSavedId ? (styles.savedRowOn ?? "") : ""}`}
              >
                <button
                  type="button"
                  className={styles.savedBody}
                  onClick={() => {
                    applySaved(saved);
                  }}
                >
                  <span className={styles.savedName}>
                    <span className={styles.savedLabel}>{saved.name}</span>
                    {(newCounts[saved.id] ?? 0) > 0 && (
                      <span className={styles.newBadge}>
                        {newCounts[saved.id]} new
                      </span>
                    )}
                  </span>
                  <span className={styles.savedMeta}>{savedMeta(saved)}</span>
                </button>
                <button
                  type="button"
                  className={styles.savedRemove}
                  aria-label={`Delete saved search ${saved.name}`}
                  onClick={() => {
                    removeSaved(saved);
                  }}
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
          <div className={styles.railFoot}>
            {savingName === undefined ? (
              <button
                type="button"
                className={styles.saveCurrent}
                disabled={kinks.length === 0 || savedSearches.length >= 12}
                onClick={() => {
                  setSavingName("");
                }}
              >
                ☆ Save current
              </button>
            ) : (
              <input
                className={styles.saveNameInput}
                value={savingName}
                autoFocus
                placeholder="Name this search…"
                aria-label="Saved search name"
                onChange={(event) => {
                  setSavingName(event.target.value);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    saveCurrent(savingName);
                  } else if (event.key === "Escape") {
                    event.stopPropagation();
                    setSavingName(undefined);
                  }
                }}
                onBlur={() => {
                  setSavingName(undefined);
                }}
              />
            )}
          </div>
        </div>
        <div className={styles.main}>
          <div className={styles.head}>
            <div>
              <h2 className={styles.title}>Search characters</h2>
              <span className={styles.sub}>
                who's online now · matches every kink you pick
              </span>
            </div>
            <button
              type="button"
              className={styles.close}
              aria-label="Close"
              onClick={onClose}
            >
              ✕
            </button>
          </div>
          <div className={styles.body}>
            <div className={styles.kinkField}>
              <div className={styles.kinkHead}>
                <span className={styles.kinkLabel}>
                  Kinks
                  <span className={styles.requiredTag}>required</span>
                </span>
                <span className={styles.kinkCount}>
                  {kinks.length} selected · pick at least one
                </span>
              </div>
              <div
                className={`${styles.kinkChips} ${kinks.length === 0 ? (styles.kinkChipsEmpty ?? "") : ""}`}
              >
                {kinks.map((id) => (
                  <span key={id} className={styles.kinkChip}>
                    {kinkById.get(id)?.name ?? id}
                    <button
                      type="button"
                      className={styles.kinkRemove}
                      aria-label={`Remove kink ${kinkById.get(id)?.name ?? id}`}
                      onClick={() => {
                        setKinks(kinks.filter((entry) => entry !== id));
                        setActiveSavedId(undefined);
                      }}
                    >
                      ✕
                    </button>
                  </span>
                ))}
                <button
                  type="button"
                  className={styles.addKinks}
                  disabled={vocab === undefined && !vocabError}
                  onClick={() => {
                    setPickerOpen((open) => !open);
                  }}
                >
                  + Add kinks…
                </button>
              </div>
              {vocabError && (
                <p className={styles.vocabError}>
                  The kink list didn't load — close the dialog and try again.
                </p>
              )}
              {pickerOpen && vocab !== undefined && (
                <div className={styles.picker}>
                  <div className={styles.pickerBar}>
                    <input
                      className={styles.pickerInput}
                      value={pickerQuery}
                      autoFocus
                      placeholder="Search kinks…"
                      aria-label="Search kinks"
                      onChange={(event) => {
                        setPickerQuery(event.target.value);
                      }}
                    />
                    <span className={styles.pickerCount}>
                      ~{vocab.length} kinks
                    </span>
                  </div>
                  <div className={styles.pickerList}>
                    {pickerMatches.map((entry) => (
                      <button
                        key={entry.id}
                        type="button"
                        className={`${styles.pickerRow} ${kinks.includes(entry.id) ? (styles.pickerRowOn ?? "") : ""}`}
                        aria-pressed={kinks.includes(entry.id)}
                        onClick={() => {
                          toggle(kinks, setKinks, entry.id);
                        }}
                      >
                        <span className={styles.pickerCheck} aria-hidden>
                          {kinks.includes(entry.id) ? "✓" : ""}
                        </span>
                        <span className={styles.pickerName}>{entry.name}</span>
                        {entry.group !== undefined && (
                          <span className={styles.pickerGroup}>
                            {entry.group}
                          </span>
                        )}
                      </button>
                    ))}
                  </div>
                  <div className={styles.pickerFoot}>
                    <span>{kinks.length} selected</span>
                    <button
                      type="button"
                      className={styles.pickerDone}
                      onClick={() => {
                        setPickerOpen(false);
                        setPickerQuery("");
                      }}
                    >
                      Done
                    </button>
                  </div>
                </div>
              )}
            </div>
            {kinks.length === 0 && !pickerOpen && (
              <div className={styles.primer}>
                <strong>Pick at least one kink to search.</strong> Everything
                else — gender, orientation, role, language, furry preference —
                is an optional way to narrow the results.
              </div>
            )}
            {resultsPane ?? (
              <>
                {filterGroup("Genders", GENDERS, genders, setGenders)}
                {filterGroup(
                  "Orientation",
                  ORIENTATIONS,
                  orientations,
                  setOrientations,
                )}
                {filterGroup("Role", ROLES, roles, setRoles)}
                {filterGroup("Languages", LANGUAGES, languages, setLanguages)}
                {filterGroup(
                  "Furry",
                  FURRYPREFS,
                  furryprefs,
                  setFurryprefs,
                  FURRYPREF_LABELS,
                )}
              </>
            )}
          </div>
          <div className={styles.footer}>
            <span className={styles.footStatus} aria-live="polite">
              {!online
                ? "Connect this character to search"
                : searching
                  ? "Searching…"
                  : coolingMs > 0
                    ? "The server takes one search every 5 seconds"
                    : kinks.length === 0
                      ? "Pick at least one kink to search"
                      : results !== undefined || refusal
                        ? "Adjust the filters and search again"
                        : "Kinks plus optional filters · online characters only"}
            </span>
            {results !== undefined || refusal ? (
              <span className={styles.footButtons}>
                <button
                  type="button"
                  className={styles.button}
                  onClick={() => {
                    lastSeenResultsRef.current = undefined;
                    useSearchStore.getState().clear(identityId);
                  }}
                >
                  Edit filters
                </button>
                <button
                  type="button"
                  className={styles.buttonPrimary}
                  disabled={!canSearch}
                  onClick={() => {
                    fire(filters, activeSavedId);
                  }}
                >
                  {coolingMs > 0
                    ? `Wait ${String(Math.ceil(coolingMs / 1000))}s…`
                    : "Search again"}
                </button>
              </span>
            ) : (
              <button
                type="button"
                className={styles.buttonPrimary}
                disabled={!canSearch}
                onClick={() => {
                  fire(filters, activeSavedId);
                }}
              >
                {coolingMs > 0
                  ? `Wait ${String(Math.ceil(coolingMs / 1000))}s…`
                  : searching
                    ? "Searching…"
                    : "Search"}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
