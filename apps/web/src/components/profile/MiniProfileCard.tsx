// Mini profile card (M8 step 8, Mini Profile Viewer.dc.html frames M8·B–G +
// COMPONENTS-profile-viewer.md §13): Discord-style popover opened by
// clicking any character name — member-list row, log nick, [user] mention.
// Fetch-through-cache off the same store the full viewer uses. Step 9: the
// compatibility block — overall pill + the two most notable dimension
// chips, or the calm no-own-profile prompt (frame M8·F).

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { match, type MatchReport } from "@emberchat/matcher";
import type { ProfileDto } from "@emberchat/protocol";
import { gateway } from "../../gateway/socket.js";
import type { SocialDto } from "../../lib/api.js";
import { dmPath } from "../../lib/routes.js";
import { loadSocial } from "../../lib/social.js";
import { nickColor } from "../../theme/tokens.js";
import {
  loadOwnProfile,
  loadProfile,
  useProfileStore,
  type CardAnchor,
  type LoadedProfile,
} from "../../stores/profile.js";
import { useSessionsStore } from "../../stores/sessions.js";
import { Avatar } from "../common/Avatar.js";
import { RateEditor } from "../ratings/RateEditor.js";
import { StarRow } from "../ratings/StarRating.js";
import ratingsStyles from "../ratings/ratings.module.css";
import { ratingFor, useRatingsStore } from "../../stores/ratings.js";
import { DimChip, MatchPill, TierPie } from "./MatchTier.js";
import { notableDimensions } from "./match-utils.js";
import { findStatusMessage } from "./mini-status.js";
import { placePopover } from "./popover.js";
import { ago } from "./time.js";
import styles from "./profile.module.css";

const CARD_WIDTH = 300;

/** The key-infotag chips row, by mapping id (design: e.g. "Bisexual · 24 ·
 * Arctic fox · Switch") — orientation, age, species, sub/dom role. */
const CHIP_INFOTAG_IDS = [2, 1, 9, 15];

/** "Your rating" block (M11 §9): composes below compatibility when the
 * user has rated this person. A low rating never hides the card — only
 * the in-log ad row collapses. */
function CardRating({ name }: { name: string }) {
  const rating = useRatingsStore((s) => ratingFor(s.byName, name));
  const [editorAnchor, setEditorAnchor] = useState<DOMRect>();
  if (!rating) {
    return null;
  }
  return (
    <div className={ratingsStyles.cardBlock}>
      <div className={ratingsStyles.cardHead}>
        <span className={styles.groupLabel}>Your rating</span>
        <span className={ratingsStyles.cardScope}>this server only</span>
      </div>
      <div className={ratingsStyles.cardStarsRow}>
        <StarRow score={rating.score} size={15} count />
        <button
          type="button"
          className={ratingsStyles.cardEdit}
          onClick={(event) => {
            setEditorAnchor(event.currentTarget.getBoundingClientRect());
          }}
        >
          Edit
        </button>
      </div>
      {rating.note !== undefined && (
        <div className={ratingsStyles.cardNote}>“{rating.note}”</div>
      )}
      {editorAnchor && (
        <RateEditor
          character={name}
          anchor={editorAnchor}
          onClose={() => {
            setEditorAnchor(undefined);
          }}
        />
      )}
    </div>
  );
}

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
  const ownProfile = useProfileStore((s) => s.ownProfile?.profile);
  const social = useSessionsStore((s) => s.sessions[identityId]?.social);
  // Live STA status message from whichever session source knows it (member
  // rosters, DM partner, friends/bookmarks) — the same data the member list
  // renders. Plain text, matching how status is shown elsewhere.
  const statusMessage = useSessionsStore((s) =>
    findStatusMessage(s.sessions[identityId], name),
  );
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
    // Own profile for the compatibility block — memoized per identity.
    void loadOwnProfile(identityId, ownCharacter);
  }, [identityId, name, ownCharacter]);

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
          statusMessage={statusMessage}
          ownProfile={self ? undefined : ownProfile}
          self={self}
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
  statusMessage,
  ownProfile,
  self,
  onRetry,
  onOpenProfile,
  onMessage,
}: {
  name: string;
  loaded: LoadedProfile | undefined;
  social: SocialDto | undefined;
  statusMessage: string | undefined;
  ownProfile: ProfileDto | undefined;
  self: boolean;
  onRetry: () => void;
  onOpenProfile: () => void;
  onMessage: (() => void) | undefined;
}) {
  const response = loaded?.response;
  const report: MatchReport | undefined = useMemo(
    () =>
      ownProfile && response ? match(ownProfile, response.profile) : undefined,
    [ownProfile, response],
  );

  if (!response && loaded && loaded.state !== "loading") {
    const budget = loaded.state === "budget";
    return (
      <div className={styles.cardError}>
        <span className={styles.emptyTile} aria-hidden>
          ?
        </span>
        <span className={styles.emptyTitle}>
          {budget
            ? "Profile budget exhausted"
            : loaded.state === "error"
              ? "Couldn't load profile"
              : "Profile not found"}
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
      {statusMessage && (
        <div className={styles.cardStatus} title={statusMessage}>
          {statusMessage}
        </div>
      )}
      {!self &&
        response &&
        (report ? (
          <div className={styles.cardMatch}>
            <span className={styles.groupLabel}>Compatibility</span>
            <div className={styles.cardMatchChips}>
              <MatchPill tier={report.overall} />
              {notableDimensions(report, 2).map((dimension) => (
                <DimChip
                  key={dimension.label}
                  label={dimension.label}
                  tier={dimension.tier}
                  title={dimension.reason}
                />
              ))}
            </div>
          </div>
        ) : (
          // Frame M8·F: the viewer has no own-profile data loaded.
          <div className={styles.cardNoMatch}>
            <TierPie tier="neutral" size={13} />
            Connect your own character to compare
          </div>
        ))}
      {!self && <CardRating name={name} />}
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
