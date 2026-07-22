// ChannelContextMenu (#234): right-click menu on a sidebar channel row,
// absorbing the old channel-header chips — Pin/Unpin, Mute/Unmute, the
// Chat/Ads/Both view (as a Show submenu, only in rooms whose server mode
// is "both"), and Leave. Same look and interaction grammar as the
// identity menu (#167): fixed popover over a click-away overlay, measured
// re-clamp, Escape closes, arrows walk the items.

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { useNavigate } from "react-router";
import { PREFS_DEFAULTS } from "@emberchat/protocol";
import { gateway } from "../../gateway/socket.js";
import { identityPath } from "../../lib/routes.js";
import { patchPrefs } from "../prefs/patch.js";
import { useEscapeToClose } from "../../lib/useEscapeToClose.js";
import { useSessionsStore, type ChannelView } from "../../stores/sessions.js";
import { adViewFor, setChannelAdView, type AdView } from "./ads.js";
import styles from "./chat.module.css";

const SHOW_OPTIONS: { value: AdView; label: string }[] = [
  { value: "chat", label: "Chat" },
  { value: "ads", label: "Ads" },
  { value: "both", label: "Both" },
];

export function ChannelContextMenu({
  identityId,
  ownCharacter,
  channel,
  active,
  position,
  onClose,
}: {
  identityId: string;
  ownCharacter: string;
  channel: ChannelView;
  /** Leaving the channel that's on screen must navigate away first. */
  active: boolean;
  position: { x: number; y: number };
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const menuRef = useRef<HTMLDivElement>(null);
  const [showOpen, setShowOpen] = useState(false);

  const prefs = useSessionsStore(
    (s) => s.sessions[identityId]?.prefs ?? PREFS_DEFAULTS,
  );
  const muted = prefs.mutedConvIds.includes(channel.convId);
  const view = adViewFor(prefs, channel.key);
  // The Chat/Ads/Both choice only means something where the server lets
  // both kinds of message through; elsewhere the item renders disabled.
  const canChooseView = channel.mode === "both";

  // Clamp against the measured menu, DOM write pre-paint (cf. the
  // identity menu) — re-runs when the Show submenu changes the size.
  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!el) {
      return;
    }
    const margin = 8;
    const rect = el.getBoundingClientRect();
    const left = Math.min(position.x, window.innerWidth - rect.width - margin);
    const top = Math.min(position.y, window.innerHeight - rect.height - margin);
    el.style.left = `${String(Math.max(margin, left))}px`;
    el.style.top = `${String(Math.max(margin, top))}px`;
  }, [position, showOpen]);

  useEscapeToClose(onClose);

  // Menus move focus into themselves; arrow keys walk the enabled items.
  useEffect(() => {
    enabledItems(menuRef.current)[0]?.focus();
  }, []);

  function onMenuKeyDown(event: ReactKeyboardEvent) {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") {
      return;
    }
    event.preventDefault();
    const items = enabledItems(menuRef.current);
    if (items.length === 0) {
      return;
    }
    const current = items.indexOf(document.activeElement as HTMLElement);
    const next =
      event.key === "ArrowDown"
        ? (current + 1) % items.length
        : (current - 1 + items.length) % items.length;
    items[next]?.focus();
  }

  /** Pin decides what an explicit reconnect rejoins (decisions.md §9). */
  function togglePin() {
    onClose();
    void gateway
      .cmd({
        identityId,
        action: "conv.pin",
        d: { convId: channel.convId, pinned: !channel.pinned },
      })
      .then((ack) => {
        if (ack.ok && ack.conversation) {
          // The update also fans out; applying the ack makes this tab instant.
          useSessionsStore
            .getState()
            .applyConversation(identityId, ack.conversation);
        } else if (!ack.ok) {
          useSessionsStore
            .getState()
            .applyNotice(identityId, "error", ack.error ?? "Could not pin");
        }
      });
  }

  /** Mute silences the alert layer only — badges keep counting. */
  function toggleMute() {
    onClose();
    // The prefs schema caps the list at 500; without this check the patch
    // is rejected server-side and the change silently reverts — say why.
    if (!muted && prefs.mutedConvIds.length >= 500) {
      useSessionsStore
        .getState()
        .applyNotice(
          identityId,
          "error",
          "Mute limit reached (500 conversations) — unmute some in Preferences → Notifications first.",
        );
      return;
    }
    void patchPrefs(identityId, {
      mutedConvIds: muted
        ? prefs.mutedConvIds.filter((entry) => entry !== channel.convId)
        : [...prefs.mutedConvIds, channel.convId],
    });
  }

  function setView(next: AdView) {
    onClose();
    void patchPrefs(identityId, setChannelAdView(prefs, channel.key, next));
  }

  /** Leave, no confirmation. The server unpins on explicit leave (#223)
   * so the pin's auto-rejoin can't drag the channel back — one gateway
   * command does both. Navigate away first when this channel is on
   * screen: the fan-out removes the row and would strand the route. */
  function leave() {
    onClose();
    if (active) {
      void navigate(identityPath(ownCharacter));
    }
    void gateway
      .cmd({
        identityId,
        action: "channel.leave",
        d: { key: channel.key },
      })
      .then((ack) => {
        if (!ack.ok) {
          useSessionsStore
            .getState()
            .applyNotice(identityId, "error", ack.error ?? "Could not leave");
        }
      });
  }

  return (
    <>
      <div
        className={styles.memberMenuOverlay}
        onClick={onClose}
        onContextMenu={(event) => {
          event.preventDefault();
          onClose();
        }}
      />
      <div
        ref={menuRef}
        className={styles.memberMenu}
        role="menu"
        aria-label={`${channel.title} menu`}
        style={{ left: position.x, top: position.y }}
        onKeyDown={onMenuKeyDown}
      >
        <div className={styles.memberMenuHead}>
          <span className={styles.memberMenuGlyph} aria-hidden>
            #
          </span>
          <span className={styles.memberMenuNick}>{channel.title}</span>
        </div>
        <button
          className={styles.memberMenuItem}
          role="menuitem"
          title={
            channel.pinned
              ? "Stop rejoining this channel when you reconnect"
              : "Rejoin this channel whenever you reconnect"
          }
          onClick={togglePin}
        >
          {channel.pinned ? "Unpin" : "Pin"}
        </button>
        <button
          className={styles.memberMenuItem}
          role="menuitem"
          title={
            muted
              ? "Sounds and notifications again"
              : "No sounds or notifications — unread counts still show"
          }
          onClick={toggleMute}
        >
          {muted ? "Unmute" : "Mute"}
        </button>
        <div
          className={styles.memberMenuSub}
          onMouseEnter={() => {
            setShowOpen(canChooseView);
          }}
          onMouseLeave={() => {
            setShowOpen(false);
          }}
        >
          <button
            className={styles.memberMenuItem}
            role="menuitem"
            aria-haspopup="menu"
            aria-expanded={showOpen}
            // Disabled, not hidden, in rooms the server locks to chat-only
            // or ads-only — the choice exists but has nothing to do (PR
            // #237 review). Native disabled also drops the item from the
            // arrow-key walk (enabledItems skips :disabled).
            disabled={!canChooseView}
            aria-disabled={!canChooseView}
            title={
              canChooseView
                ? "Choose whether this channel shows chat, roleplay ads, or both"
                : "This channel allows only one kind of message, so there is nothing to choose"
            }
            onClick={() => {
              setShowOpen(!showOpen);
            }}
            onKeyDown={(event) => {
              if (event.key === "ArrowRight" || event.key === "Enter") {
                event.preventDefault();
                event.stopPropagation();
                setShowOpen(true);
              }
            }}
          >
            Show
            <span className={styles.memberMenuSubArrow} aria-hidden>
              ▸
            </span>
          </button>
          {showOpen && (
            <div
              className={styles.memberMenuSubPanel}
              role="menu"
              aria-label="Show chat, ads, or both"
              onKeyDown={(event) => {
                if (event.key === "ArrowLeft") {
                  event.stopPropagation();
                  setShowOpen(false);
                  enabledItems(menuRef.current)[0]?.focus();
                }
              }}
            >
              {SHOW_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  className={styles.memberMenuItem}
                  role="menuitemradio"
                  aria-checked={view === option.value}
                  onClick={() => {
                    setView(option.value);
                  }}
                >
                  {option.label}
                  {view === option.value && (
                    <span className={styles.memberMenuCheck} aria-hidden>
                      ✓
                    </span>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>
        <div className={styles.memberMenuDivider} />
        <button
          className={`${styles.memberMenuItem} ${styles.memberMenuDanger ?? ""}`}
          role="menuitem"
          title="Leave this channel — it also stops rejoining on reconnect"
          onClick={leave}
        >
          Leave channel
        </button>
      </div>
    </>
  );
}

function enabledItems(root: HTMLDivElement | null): HTMLElement[] {
  return root
    ? [
        ...root.querySelectorAll<HTMLElement>(
          '[role="menuitem"]:not(:disabled), [role="menuitemradio"]:not(:disabled)',
        ),
      ]
    : [];
}
