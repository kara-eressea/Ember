// Guestbook tab (COMPONENTS-profile-viewer.md §12, frame P·G): pages of 10
// from the verified character-guestbook endpoint, shown only when the
// profile's settings enable it (character-data tells us for free). Pages
// spend the character-data budget like a profile fetch — loaded on tab
// open, one page at a time. Read-only: no posting endpoint was verified,
// so signing links out to f-list.net instead of faking a compose box.

import { useCallback, useEffect, useState } from "react";
import type { GuestbookPage, ProfileDto } from "@emberchat/protocol";
import { api, ApiError } from "../../lib/api.js";
import { nickColor } from "../../theme/tokens.js";
import { Avatar } from "../common/Avatar.js";
import { ProfileBBCode } from "./ProfileBBCode.js";
import { dateLabel } from "./time.js";
import styles from "./profile.module.css";

interface Loaded {
  posts: GuestbookPage["posts"];
  nextPage: boolean;
  pagesLoaded: number;
}

export function GuestbookTab({
  identityId,
  profile,
}: {
  identityId: string;
  profile: ProfileDto;
}) {
  const enabled = profile.settings.guestbook;
  const [loaded, setLoaded] = useState<Loaded>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const name = profile.name;

  const fetchPage = useCallback(
    (page: number, previous?: Loaded) => {
      api
        .getProfileGuestbook(identityId, name, page)
        .then((result) => {
          setLoaded({
            posts: [...(previous?.posts ?? []), ...result.posts],
            nextPage: result.nextPage,
            pagesLoaded: page + 1,
          });
          setError(undefined);
        })
        .catch((caught: unknown) => {
          setError(
            caught instanceof ApiError
              ? caught.message
              : "Could not load the guestbook",
          );
        })
        .finally(() => {
          setBusy(false);
        });
    },
    [identityId, name],
  );

  useEffect(() => {
    if (enabled) {
      fetchPage(0);
    }
  }, [enabled, fetchPage]);

  if (!enabled) {
    return (
      <div className={styles.emptyState}>
        <span className={styles.emptyTile} aria-hidden>
          ”
        </span>
        <span className={styles.emptyTitle}>No guestbook</span>
        <span className={styles.emptyBody}>
          {profile.name} has the guestbook turned off.
        </span>
      </div>
    );
  }
  if (error !== undefined) {
    return (
      <div className={styles.emptyState}>
        <span className={styles.emptyTile} aria-hidden>
          ”
        </span>
        <span className={styles.emptyTitle}>Couldn't load the guestbook</span>
        <span className={styles.emptyBody}>
          {error}
          <span className={styles.emptyActions}>
            <button
              type="button"
              className={styles.button}
              onClick={() => {
                setError(undefined);
                fetchPage(loaded?.pagesLoaded ?? 0, loaded);
              }}
            >
              Retry
            </button>
          </span>
        </span>
      </div>
    );
  }
  if (!loaded) {
    return <div className={styles.shimmer} style={{ height: 120 }} />;
  }
  if (loaded.posts.length === 0) {
    return (
      <div className={styles.emptyState}>
        <span className={styles.emptyTile} aria-hidden>
          ”
        </span>
        <span className={styles.emptyTitle}>No guestbook posts yet</span>
        <span className={styles.emptyBody}>
          <SignLink name={profile.name} />
        </span>
      </div>
    );
  }

  return (
    <div className={styles.gbList}>
      {loaded.posts.map((post) => (
        <article key={post.id} className={styles.gbPost}>
          <Avatar name={post.character} size={32} square />
          <div className={styles.gbBody}>
            <div className={styles.gbHead}>
              <span
                className={styles.gbAuthor}
                style={{ color: nickColor(post.character) }}
              >
                {post.character}
              </span>
              {post.postedAt !== null && (
                <span className={styles.gbDate}>
                  {dateLabel(post.postedAt * 1000)}
                </span>
              )}
            </div>
            <div className={styles.gbMessage}>
              <ProfileBBCode bbcode={post.message} />
            </div>
            {post.reply !== null && post.reply !== "" && (
              <div className={styles.gbReply}>
                <span className={styles.gbReplyLabel}>
                  {profile.name} replied
                </span>
                <ProfileBBCode bbcode={post.reply} />
              </div>
            )}
          </div>
        </article>
      ))}
      <div className={styles.gbFoot}>
        {loaded.nextPage &&
          (busy ? (
            <div className={styles.shimmer} style={{ height: 30, width: 96 }} />
          ) : (
            <button
              type="button"
              className={styles.button}
              onClick={() => {
                setBusy(true);
                fetchPage(loaded.pagesLoaded, loaded);
              }}
            >
              Load more
            </button>
          ))}
        <SignLink name={profile.name} />
      </div>
    </div>
  );
}

function SignLink({ name }: { name: string }) {
  return (
    <a
      className={styles.gbSign}
      href={`https://www.f-list.net/c/${encodeURIComponent(name)}`}
      target="_blank"
      rel="noreferrer noopener"
    >
      Sign the guestbook on f-list.net ↗
    </a>
  );
}
