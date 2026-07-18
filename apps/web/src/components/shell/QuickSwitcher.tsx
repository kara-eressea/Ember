// Quick-switcher (M9 step 6): Ctrl/Cmd+K palette — type to fuzzy-jump to
// any of the active identity's channels or DMs, or to another identity.
// Client-only; candidates come straight from session state. ARIA combobox:
// the input owns focus, arrows move the active option, Enter navigates.

import { useMemo, useRef, useState, useEffect } from "react";
import { useNavigate } from "react-router";
import { channelPath, dmPath, identityPath } from "../../lib/routes.js";
import type { IdentitySession } from "../../stores/sessions.js";
import { Avatar } from "../common/Avatar.js";
import { rankCandidates, type SwitchCandidate } from "./quick-switch.js";
import styles from "./shell.module.css";

const KIND_GLYPH = { channel: "#", dm: "@", identity: "⇄" } as const;

export function QuickSwitcher({
  session,
  identities,
  onClose,
}: {
  session: IdentitySession;
  identities: { id: string; name: string }[];
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const candidates = useMemo<SwitchCandidate[]>(() => {
    const channels = Object.values(session.channels)
      .filter((channel) => channel.convId !== "")
      .map((channel) => ({
        id: channel.convId,
        kind: "channel" as const,
        label: channel.title,
        path: channelPath(session.character, channel.key),
      }));
    const dms = Object.values(session.dms).map((dm) => ({
      id: dm.convId,
      kind: "dm" as const,
      label: dm.partner,
      path: dmPath(session.character, dm.partner),
    }));
    const others = identities
      .filter((identity) => identity.id !== session.identityId)
      .map((identity) => ({
        id: identity.id,
        kind: "identity" as const,
        label: identity.name,
        path: identityPath(identity.name),
      }));
    return [...dms, ...channels, ...others];
  }, [session, identities]);

  const matches = useMemo(
    () => rankCandidates(query, candidates),
    [query, candidates],
  );
  const activeIndex = Math.min(active, Math.max(matches.length - 1, 0));

  function pick(index: number) {
    const match = matches[index];
    if (match) {
      void navigate(match.path);
    }
    onClose();
  }

  return (
    <>
      <div className={styles.switcherOverlay} onClick={onClose} />
      <div
        className={styles.switcher}
        role="dialog"
        aria-label="Quick switcher"
      >
        <input
          ref={inputRef}
          className={styles.switcherInput}
          role="combobox"
          aria-expanded={matches.length > 0}
          aria-controls="quick-switcher-list"
          aria-activedescendant={
            matches[activeIndex] ? `qs-${matches[activeIndex].id}` : undefined
          }
          placeholder="Jump to a channel, conversation, or identity…"
          aria-label="Quick switcher"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              onClose();
            } else if (event.key === "ArrowDown") {
              event.preventDefault();
              setActive((index) => Math.min(index + 1, matches.length - 1));
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              setActive((index) => Math.max(index - 1, 0));
            } else if (event.key === "Enter") {
              event.preventDefault();
              pick(activeIndex);
            }
          }}
        />
        <div
          id="quick-switcher-list"
          className={styles.switcherList}
          role="listbox"
          aria-label="Destinations"
        >
          {matches.length === 0 && (
            <div className={styles.switcherEmpty}>Nothing matches.</div>
          )}
          {matches.map((match, index) => (
            <button
              key={`${match.kind}:${match.id}`}
              id={`qs-${match.id}`}
              type="button"
              role="option"
              aria-selected={index === activeIndex}
              className={`${styles.switcherRow} ${
                index === activeIndex ? (styles.switcherRowActive ?? "") : ""
              }`}
              onMouseEnter={() => {
                setActive(index);
              }}
              onClick={() => {
                pick(index);
              }}
            >
              <span className={styles.switcherGlyph} aria-hidden>
                {KIND_GLYPH[match.kind]}
              </span>
              {match.kind !== "channel" && (
                <Avatar name={match.label} size={20} />
              )}
              <span className={styles.switcherLabel}>{match.label}</span>
              {match.kind === "identity" && (
                <span className={styles.switcherHint}>switch identity</span>
              )}
            </button>
          ))}
        </div>
      </div>
    </>
  );
}
