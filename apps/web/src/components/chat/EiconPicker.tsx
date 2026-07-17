// EiconPicker (M8 step 11, COMPONENTS-link-preview-eicon.md §3, frames
// K·A–K·E): popover anchored above the composer's ☺ button, replacing the
// old inline name-input panel. Favorites and Recents are live; the Search
// tab ships disabled — the server-local xariah index and its opt-in pref
// arrive with step 12, which also wires the "Enable in Preferences" link.
// Anchoring/clamping reuses the §13 primitive (mini profile card).

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { UserPrefs } from "@emberchat/protocol";
import { eiconUrl } from "../../lib/avatar.js";
import { placePopover } from "../profile/popover.js";
import { patchPrefs } from "../prefs/patch.js";
import type { CardAnchor } from "../../stores/profile.js";
import styles from "./chat.module.css";

const PICKER_WIDTH = 336;

const TABS = [
  { id: "favorites", label: "Favorites" },
  { id: "recents", label: "Recents" },
  { id: "search", label: "Search" },
] as const;

type TabId = (typeof TABS)[number]["id"];

export function EiconPicker({
  identityId,
  prefs,
  anchor,
  iconsBlacklisted,
  onInsert,
  onClose,
}: {
  identityId: string;
  prefs: UserPrefs;
  anchor: CardAnchor;
  /** This channel's icon_blacklist warning rides the picker footer. */
  iconsBlacklisted: boolean;
  onInsert: (name: string) => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<TabId>("favorites");
  const panelRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number }>();
  const [placement, setPlacement] = useState<"above" | "below">("above");

  useEffect(() => {
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

  // Measure and place per §13 — the composer sits at the bottom of the
  // viewport, so the below-start preference flips this above the ☺ button
  // (where the caret points) in every realistic layout.
  useLayoutEffect(() => {
    const element = panelRef.current;
    if (!element) {
      return;
    }
    const placed = placePopover(
      anchor,
      { width: PICKER_WIDTH, height: element.offsetHeight },
      { width: window.innerWidth, height: window.innerHeight },
    );
    setPos({ top: placed.top, left: placed.left });
    setPlacement(placed.placement === "below" ? "below" : "above");
  }, [anchor, tab]);

  function toggleFavorite(name: string) {
    const has = prefs.eiconFavorites.some(
      (fav) => fav.toLowerCase() === name.toLowerCase(),
    );
    void patchPrefs(identityId, {
      eiconFavorites: has
        ? prefs.eiconFavorites.filter(
            (fav) => fav.toLowerCase() !== name.toLowerCase(),
          )
        : // Schema caps at 100 — drop the oldest rather than refuse.
          [...prefs.eiconFavorites.slice(-99), name],
    });
  }

  return (
    <>
      <div className={styles.pickerOverlay} onClick={onClose} />
      <div
        ref={panelRef}
        className={styles.eiconPicker}
        role="dialog"
        aria-label="Eicon picker"
        style={
          pos
            ? { top: pos.top, left: pos.left }
            : { top: anchor.top, left: anchor.left, visibility: "hidden" }
        }
      >
        <div className={styles.pickerTabs} role="tablist">
          {TABS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              role="tab"
              aria-selected={entry.id === tab}
              className={`${styles.pickerTab} ${
                entry.id === tab ? (styles.pickerTabActive ?? "") : ""
              } ${entry.id === "search" ? (styles.pickerTabOff ?? "") : ""}`}
              onClick={() => {
                setTab(entry.id);
              }}
            >
              {entry.label}
              {entry.id === "search" && <span aria-hidden> ⊘</span>}
            </button>
          ))}
        </div>
        <div className={styles.pickerBody}>
          {tab === "search" ? (
            <PickerNote glyph="⊘" title="Eicon search is off">
              Searching uses an index downloaded from xariah.net, a third-party
              service. Support arrives in a coming update — favorites and
              recents work today.
            </PickerNote>
          ) : (
            <TileGrid
              names={
                tab === "favorites" ? prefs.eiconFavorites : prefs.eiconRecents
              }
              favorites={prefs.eiconFavorites}
              empty={
                tab === "favorites" ? (
                  <PickerNote glyph="☆" title="No favorites yet">
                    Tap the star on any eicon to keep it here.
                  </PickerNote>
                ) : (
                  <PickerNote glyph="↺" title="Nothing used yet">
                    Eicons you insert will show up here.
                  </PickerNote>
                )
              }
              onInsert={onInsert}
              onToggleFavorite={toggleFavorite}
            />
          )}
        </div>
        <div className={styles.pickerFoot}>
          {iconsBlacklisted
            ? "this channel disallows icons — the server will reject them"
            : "click to insert · ☆ to favorite"}
        </div>
        <span
          className={`${styles.pickerCaret} ${
            placement === "below" ? (styles.pickerCaretUp ?? "") : ""
          }`}
          aria-hidden
        />
      </div>
    </>
  );
}

function TileGrid({
  names,
  favorites,
  empty,
  onInsert,
  onToggleFavorite,
}: {
  names: readonly string[];
  favorites: readonly string[];
  empty: React.ReactNode;
  onInsert: (name: string) => void;
  onToggleFavorite: (name: string) => void;
}) {
  if (names.length === 0) {
    return <>{empty}</>;
  }
  return (
    <div className={styles.pickerGrid}>
      {names.map((name) => {
        const favorite = favorites.some(
          (fav) => fav.toLowerCase() === name.toLowerCase(),
        );
        return (
          <span key={name} className={styles.eiconTile} title={name}>
            <button
              type="button"
              className={styles.eiconTileInsert}
              aria-label={`Insert ${name}`}
              onClick={() => {
                onInsert(name);
              }}
            >
              <EiconImage name={name} />
            </button>
            <button
              type="button"
              className={`${styles.eiconTileStar} ${
                favorite ? (styles.eiconTileStarOn ?? "") : ""
              }`}
              aria-label={
                favorite
                  ? `Remove ${name} from favorites`
                  : `Add ${name} to favorites`
              }
              onClick={() => {
                onToggleFavorite(name);
              }}
            >
              {favorite ? "★" : "☆"}
            </button>
          </span>
        );
      })}
    </div>
  );
}

/** 60px tile image with the mono-name fallback when the URL builder
 * refuses the charset (should not happen — the pref schema gates it). */
function EiconImage({ name }: { name: string }) {
  const src = eiconUrl(name);
  if (src === undefined) {
    return <span className={styles.eiconTileName}>{name}</span>;
  }
  return <img src={src} alt="" width={58} height={58} loading="lazy" />;
}

function PickerNote({
  glyph,
  title,
  children,
}: {
  glyph: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className={styles.pickerNote}>
      <span className={styles.pickerNoteTile} aria-hidden>
        {glyph}
      </span>
      <span className={styles.pickerNoteTitle}>{title}</span>
      <span className={styles.pickerNoteBody}>{children}</span>
    </div>
  );
}
