// Mini profile card (M8 step 8, Mini Profile Viewer.dc.html frames M8·B–G +
// COMPONENTS-profile-viewer.md §13): Discord-style popover opened by
// clicking any character name — member-list row, log nick, [user] mention.
// Fetch-through-cache off the same store the full viewer uses; match chips
// arrive with the matcher surfaces (step 9).

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { gateway } from "../../gateway/socket.js";
import type { SocialDto } from "../../lib/api.js";
import { dmPath } from "../../lib/routes.js";
import { loadSocial } from "../../lib/social.js";
import { nickColor } from "../../theme/tokens.js";
import {
  loadProfile,
  useProfileStore,
  type CardAnchor,
  type LoadedProfile,
} from "../../stores/profile.js";
import { useSessionsStore } from "../../stores/sessions.js";
import { Avatar } from "../common/Avatar.js";
import { placePopover } from "./popover.js";
import { ago } from "./time.js";
import styles from "./profile.module.css";

const CARD_WIDTH = 300;

/** The key-infotag chips row, by mapping id (design: e.g. "Bisexual · 24 ·
 * Arctic fox · Switch") — orientation, age, species, sub/dom role. */
const CHIP_INFOTAG_IDS = [2, 1, 9, 15];

export function MiniProfileCard({
  identityId,
  ownCharacter,
  name,
  anchor,
  onClose,
}: {
  identityId: string;
  ownCharacter: string;
  name: string;
  anchor: CardAnchor;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const loaded = useProfileStore((s) => s.profiles[name.toLowerCase()]);
  const social = useSessionsStore((s) => s.sessions[identityId]?.social);
  const self = name.toLowerCase() === ownCharacter.toLowerCase();
  const cardRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{
    top: number;
    left: number;
    maxHeight: number;
  }>();

  useEffect(() => {
    void loadProfile(identityId, name);
    void loadSocial(identityId);
  }, [identityId, name]);

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

  // Measure after render, place per §13. Re-runs when the content state
  // changes shape (skeleton → loaded → error) since the height changes.
  const contentState = loaded?.state ?? "loading";
  useLayoutEffect(() => {
    const element = cardRef.current;
    if (!element) {
      return;
    }
    setPos(
      placePopover(
        anchor,
        { width: CARD_WIDTH, height: element.offsetHeight },
        { width: window.innerWidth, height: window.innerHeight },
      ),
    );
  }, [anchor, contentState]);

  function message() {
    onClose();
    void gateway
      .cmd({ identityId, action: "pm.open", d: { character: name } })
      .then((ack) => {
        if (!ack.ok || !ack.conversation) {
          useSessionsStore
            .getState()
            .applyNotice(
              identityId,
              "error",
              ack.error ?? "Could not open the conversation",
            );
          return;
        }
        useSessionsStore
          .getState()
          .applyConversation(identityId, ack.conversation);
        void navigate(
          dmPath(ownCharacter, ack.conversation.partnerCharacter ?? ""),
        );
      });
  }

  return (
    <>
      <div
        className={styles.cardOverlay}
        onClick={onClose}
        onContextMenu={(event) => {
          event.preventDefault();
          onClose();
        }}
      />
      <div
        ref={cardRef}
        className={styles.card}
        role="dialog"
        aria-label={`Profile card: ${name}`}
        style={
          pos
            ? { top: pos.top, left: pos.left, maxHeight: pos.maxHeight }
            : {
                top: anchor.bottom + 6,
                left: anchor.left,
                visibility: "hidden",
              }
        }
      >
        <CardContent
          name={name}
          loaded={loaded}
          social={social}
          onRetry={() => {
            void loadProfile(identityId, name, true);
          }}
          onOpenProfile={() => {
            // open() clears the card in the store — the §13 hand-off.
            useProfileStore.getState().open(name);
          }}
          onMessage={self ? undefined : message}
        />
      </div>
    </>
  );
}

function CardContent({
  name,
  loaded,
  social,
  onRetry,
  onOpenProfile,
  onMessage,
}: {
  name: string;
  loaded: LoadedProfile | undefined;
  social: SocialDto | undefined;
  onRetry: () => void;
  onOpenProfile: () => void;
  onMessage: (() => void) | undefined;
}) {
  const response = loaded?.response;

  if (!response && loaded && loaded.state !== "loading") {
    const budget = loaded.state === "budget";
    return (
      <div className={styles.cardError}>
        <span className={styles.emptyTile} aria-hidden>
          ?
        </span>
        <span className={styles.emptyTitle}>
          {budget ? "Profile budget exhausted" : "Profile not found"}
        </span>
        <span className={styles.emptyBody}>
          {loaded.error ??
            "This character may have been renamed or deleted on the server."}
        </span>
        <button type="button" className={styles.button} onClick={onRetry}>
          Retry
        </button>
      </div>
    );
  }

  const lower = name.toLowerCase();
  const isFriend =
    social?.friends.some((row) => row.name.toLowerCase() === lower) ?? false;
  const isBookmarked =
    social?.bookmarks.some((row) => row.name.toLowerCase() === lower) ?? false;
  const accent = nickColor(name);

  const chips = response
    ? CHIP_INFOTAG_IDS.flatMap((id) => {
        const tag = response.profile.infotagGroups
          .flatMap((group) => group.tags)
          .find((entry) => entry.id === id);
        return tag ? [tag.value] : [];
      })
    : [];

  return (
    <>
      <div
        className={styles.cardHeader}
        style={{ "--gender-accent": accent } as React.CSSProperties}
      >
        <Avatar name={name} size={64} square />
        <div className={styles.cardHeaderInfo}>
          <div className={styles.nameRow}>
            <span className={styles.cardName}>{name}</span>
            {isFriend && (
              <span
                className={`${styles.badge} ${styles.badgeFriend}`}
                title="Friend"
              >
                ★
              </span>
            )}
            {isBookmarked && (
              <span
                className={`${styles.badge} ${styles.badgeBookmarkOn}`}
                title="Bookmarked"
              >
                ⚑
              </span>
            )}
          </div>
          <div className={styles.cardChips}>
            {response ? (
              chips.map((chip) => (
                <span key={chip} className={styles.cardChip}>
                  {chip}
                </span>
              ))
            ) : (
              <>
                <span
                  className={styles.shimmer}
                  style={{ width: 54, height: 18 }}
                />
                <span
                  className={styles.shimmer}
                  style={{ width: 40, height: 18 }}
                />
                <span
                  className={styles.shimmer}
                  style={{ width: 58, height: 18 }}
                />
              </>
            )}
          </div>
        </div>
      </div>
      {response && (response.stale || response.budgetExhausted) && (
        <div className={styles.cardStale}>
          <span aria-hidden>⟲</span>
          cached {ago(response.fetchedAt)}
        </div>
      )}
      <div className={styles.cardActions}>
        <button
          type="button"
          className={styles.cardPrimary}
          onClick={onOpenProfile}
        >
          Open profile
        </button>
        {onMessage && (
          <button
            type="button"
            className={styles.cardGhost}
            onClick={onMessage}
          >
            Message
          </button>
        )}
      </div>
    </>
  );
}
