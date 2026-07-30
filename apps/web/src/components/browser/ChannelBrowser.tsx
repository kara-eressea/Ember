// Channel browser dialog (COMPONENTS.md §11): Official / Open-rooms tabs
// with count pills, filter by name or topic, state-aware Join buttons, and
// the footer join-hidden-by-name input — hidden/invite-only rooms use ADH-
// ids and never appear in listings. Listing data comes from the server-side
// channel_directory cache; the header shows how stale its point-in-time
// counts are instead of pretending they are live.

import { useEffect, useRef, useState, type FormEvent } from "react";
import { useNavigate } from "react-router";
import { useVirtualizer } from "@tanstack/react-virtual";
import { gateway } from "../../gateway/socket.js";
import { api, type DirectoryChannelDto } from "../../lib/api.js";
import { appConfig } from "../../lib/config.js";
import { channelPath } from "../../lib/routes.js";
import { decodeWireEntities } from "../../lib/wire-text.js";
import {
  useSessionsStore,
  type ChannelView,
  type IdentitySession,
} from "../../stores/sessions.js";
import {
  filterDirectory,
  joinStateFor,
  sortByMembers,
  stalenessLabel,
} from "./browser-data.js";
import styles from "./browser.module.css";

const ROW_HEIGHT = 45;

/** Bounded wait for the joined conversation row to reach the store (same
 * contract as the sidebar join form — the ack only confirms the send). */
async function waitForJoin(
  identityId: string,
  key: string,
): Promise<ChannelView | undefined> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const channel =
      useSessionsStore.getState().sessions[identityId]?.channels[key];
    if (channel?.joined) {
      return channel;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return undefined;
}

/** CCR's ack can't carry the minted ADH- id (the server assigns it in the
 * JCH echo) — watch for a newly joined ADH- room that wasn't there before. */
async function waitForCreatedRoom(
  identityId: string,
  before: ReadonlySet<string>,
): Promise<ChannelView | undefined> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const channels =
      useSessionsStore.getState().sessions[identityId]?.channels ?? {};
    for (const [key, channel] of Object.entries(channels)) {
      if (key.startsWith("ADH-") && channel.joined && !before.has(key)) {
        return channel;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return undefined;
}

interface DirectoryData {
  channels: DirectoryChannelDto[];
  refreshedAt: string | null;
  /** Client clock at fetch time — the staleness label's "now". */
  fetchedAt: number;
}

export function ChannelBrowser({
  session,
  onClose,
}: {
  session: IdentitySession;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<"official" | "open">("official");
  const [query, setQuery] = useState("");
  const [data, setData] = useState<DirectoryData>();
  const [loadError, setLoadError] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  // Autofocus the filter on open — mount-only on purpose. Tying this to a
  // dependency (the old version keyed it on `onClose`, an inline prop that
  // changes identity whenever the shell re-renders) makes the effect re-run
  // mid-typing and yank focus away from the input.
  useEffect(() => {
    searchRef.current?.focus();
  }, []);

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

  useEffect(() => {
    let cancelled = false;
    api
      .getDirectory(session.identityId)
      .then((directory) => {
        if (!cancelled) {
          setData({ ...directory, fetchedAt: Date.now() });
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
  }, [session.identityId]);

  const channels = data?.channels ?? [];
  const official = channels.filter((c) => c.kind === "official");
  const open = channels.filter((c) => c.kind === "open");
  const rows = sortByMembers(
    filterDirectory(tab === "official" ? official : open, query),
  );

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
        aria-label="Browse channels"
      >
        <header className={styles.head}>
          <div>
            <h2 className={styles.title}>Browse channels</h2>
            <div className={styles.sub}>
              {appConfig().appName} ·{" "}
              {data ? stalenessLabel(data.refreshedAt, data.fetchedAt) : "…"} ·{" "}
              <span className={styles.subCount}>{channels.length} rooms</span>
            </div>
          </div>
          <button
            type="button"
            className={styles.close}
            aria-label="Close channel browser"
            onClick={onClose}
          >
            ✕
          </button>
        </header>

        <div className={styles.searchRow}>
          <input
            className={styles.search}
            ref={searchRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
            }}
            placeholder="Filter by name or topic…"
            aria-label="Filter channels"
          />
        </div>

        <div className={styles.tabs} role="tablist">
          <TabButton
            label="Official"
            count={official.length}
            active={tab === "official"}
            onClick={() => {
              setTab("official");
            }}
          />
          <TabButton
            label="Open rooms"
            count={open.length}
            active={tab === "open"}
            onClick={() => {
              setTab("open");
            }}
          />
        </div>

        {loadError ? (
          <p className={styles.notice} role="alert">
            Could not load the channel list — try again in a moment.
          </p>
        ) : (
          <ChannelRows rows={rows} session={session} />
        )}

        <HiddenJoinFooter session={session} onClose={onClose} />
      </div>
    </div>
  );
}

function TabButton({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      className={`${styles.tab} ${active ? styles.tabActive : ""}`}
      onClick={onClick}
    >
      {label}
      <span className={styles.tabCount}>{count}</span>
    </button>
  );
}

function ChannelRows({
  rows,
  session,
}: {
  rows: DirectoryChannelDto[];
  session: IdentitySession;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
  });

  return (
    <div className={styles.list} ref={scrollRef}>
      {rows.length === 0 && <p className={styles.notice}>No channels match.</p>}
      <div
        className={styles.listInner}
        style={{ height: virtualizer.getTotalSize() }}
      >
        {virtualizer.getVirtualItems().map((item) => {
          const channel = rows[item.index]!;
          // Room titles are wire text the server entity-escapes (#350); decode
          // before display since the browser renders them as plain text, never
          // through RichText.
          const title = decodeWireEntities(channel.title);
          return (
            <div
              key={channel.key}
              className={styles.row}
              style={{ transform: `translateY(${String(item.start)}px)` }}
            >
              <span className={styles.rowGlyph}>#</span>
              <span className={styles.rowName} title={title}>
                {title}
              </span>
              <span
                className={
                  channel.kind === "official"
                    ? styles.chipOfficial
                    : styles.chipOpen
                }
              >
                {channel.kind}
              </span>
              <span className={styles.rowCount}>
                <span className={styles.countDot} />
                {channel.characters}
              </span>
              <JoinButton channel={channel} session={session} />
            </div>
          );
        })}
      </div>
    </div>
  );
}

function JoinButton({
  channel,
  session,
}: {
  channel: DirectoryChannelDto;
  session: IdentitySession;
}) {
  const [busy, setBusy] = useState(false);
  const state = joinStateFor(channel.key, session.channels);

  async function join() {
    if (busy) {
      return;
    }
    setBusy(true);
    try {
      const ack = await gateway.cmd({
        identityId: session.identityId,
        action: "channel.join",
        d: { key: channel.key },
      });
      if (ack.ok) {
        // The button flips to ✓ Joined through the store once the join
        // round-trips; the dialog stays open for more browsing.
        await waitForJoin(session.identityId, channel.key);
      }
    } finally {
      setBusy(false);
    }
  }

  if (state === "pinned") {
    return <span className={styles.statePinned}>⚲ Pinned</span>;
  }
  if (state === "joined") {
    return <span className={styles.stateJoined}>✓ Joined</span>;
  }
  return (
    <button
      type="button"
      className={styles.joinButton}
      aria-label={`Join ${decodeWireEntities(channel.title)}`}
      disabled={busy || session.sessionStatus !== "online"}
      onClick={() => {
        void join();
      }}
    >
      Join
    </button>
  );
}

function HiddenJoinFooter({
  session,
  onClose,
}: {
  session: IdentitySession;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  async function submit(event: FormEvent) {
    event.preventDefault();
    const trimmed = key.trim();
    if (!trimmed || busy) {
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      const ack = await gateway.cmd({
        identityId: session.identityId,
        action: "channel.join",
        d: { key: trimmed },
      });
      if (!ack.ok) {
        setError(ack.error ?? "Could not join");
        return;
      }
      const channel = await waitForJoin(session.identityId, trimmed);
      if (!channel) {
        setError("No response from the channel — check the name");
        return;
      }
      onClose();
      void navigate(channelPath(session.character, channel.key));
    } finally {
      setBusy(false);
    }
  }

  return (
    <footer className={styles.footer}>
      <div className={styles.footerLabel}>
        Not listed? Join a hidden channel by name
      </div>
      <form
        className={styles.footerForm}
        onSubmit={(event) => {
          void submit(event);
        }}
      >
        <span className={styles.footerHash}>#</span>
        <input
          className={styles.footerInput}
          value={key}
          onChange={(e) => {
            setKey(e.target.value);
          }}
          placeholder="ADH-…"
          aria-label="Join a hidden channel by name"
        />
        <button
          type="submit"
          className={styles.joinButton}
          disabled={busy || session.sessionStatus !== "online"}
        >
          Join
        </button>
      </form>
      {error ? (
        <p className={styles.footerError} role="alert">
          {error}
        </p>
      ) : (
        <p className={styles.footerNote}>
          Hidden and invite-only rooms won&apos;t appear in the lists above.
        </p>
      )}
      <CreateRoomForm session={session} onClose={onClose} />
    </footer>
  );
}

/**
 * CCR: creates a private, invite-only room (the title is the payload; the
 * server mints the ADH- id). New rooms start unlisted — open them up or
 * invite people from the room header.
 */
function CreateRoomForm({
  session,
  onClose,
}: {
  session: IdentitySession;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  async function submit(event: FormEvent) {
    event.preventDefault();
    const trimmed = title.trim();
    if (!trimmed || busy) {
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      const before = new Set(
        Object.keys(
          useSessionsStore.getState().sessions[session.identityId]?.channels ??
            {},
        ),
      );
      const ack = await gateway.cmd({
        identityId: session.identityId,
        action: "channel.create",
        d: { title: trimmed },
      });
      if (!ack.ok) {
        setError(ack.error ?? "Could not create the room");
        return;
      }
      const channel = await waitForCreatedRoom(session.identityId, before);
      if (!channel) {
        setError("The server never confirmed the room — try again");
        return;
      }
      onClose();
      void navigate(channelPath(session.character, channel.key));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div
        className={`${styles.footerLabel} ${styles.footerLabelSpaced ?? ""}`}
      >
        Create a private room
      </div>
      <form
        className={styles.footerForm}
        onSubmit={(event) => {
          void submit(event);
        }}
      >
        <input
          className={styles.footerInput}
          value={title}
          onChange={(e) => {
            setTitle(e.target.value);
          }}
          maxLength={64}
          placeholder="Room title…"
          aria-label="Create a private room"
        />
        <button
          type="submit"
          className={styles.joinButton}
          disabled={busy || session.sessionStatus !== "online"}
        >
          Create
        </button>
      </form>
      {error ? (
        <p className={styles.footerError} role="alert">
          {error}
        </p>
      ) : (
        <p className={styles.footerNote}>
          New rooms start invite-only; open them up from the room header.
        </p>
      )}
    </>
  );
}
