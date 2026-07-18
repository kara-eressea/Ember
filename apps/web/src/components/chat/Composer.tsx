// Composer (COMPONENTS.md §8): Markdown composing with a live preview panel
// rendered through the same RichText pipeline as the log — what you preview
// is exactly what recipients see. The Ⓜ toggle switches Markdown mode (off =
// raw BBCode passthrough, the M1 behavior); Enter sends, Shift+Enter breaks
// the line. The byte counter counts the translated wire form — that is what
// the server measures.

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import {
  analyzeMarkdown,
  BB_COLORS,
  mdToBBCode,
} from "@emberchat/markdown-bbcode";
import { gateway } from "../../gateway/socket.js";
import {
  useSessionsStore,
  type IdentitySession,
} from "../../stores/sessions.js";
import type { CardAnchor } from "../../stores/profile.js";
import { useUiStore } from "../../stores/ui.js";
import { patchPrefs } from "../prefs/patch.js";
import { eiconsIn, mergeRecents } from "./eicon-recents.js";
import { EiconPicker } from "./EiconPicker.js";
import { HelpPanel } from "./HelpPanel.js";
import { parseEmote } from "./rich-text.js";
import { RichText } from "./RichText.js";
import { parseSlash, SlashUsageError } from "./slash.js";
import styles from "./chat.module.css";

/** The textarea grows with its content up to this, then scrolls. */
const MAX_INPUT_HEIGHT_PX = 160;

const MARKDOWN_MODE_KEY = "emberchat.composeMarkdown";

const utf8 = new TextEncoder();

function savedMarkdownMode(): boolean {
  try {
    return localStorage.getItem(MARKDOWN_MODE_KEY) !== "off";
  } catch {
    return true;
  }
}

export interface ComposerProps {
  session: IdentitySession;
  convId: string;
  /** Channel key when the conversation is a channel (icon_blacklist check). */
  channelKey?: string;
  /** The channel's room mode (chat/ads/both) — gates the ad toggle. */
  channelMode?: string;
  /** The channel's Chat/Ads/Both view (M10, "both"-mode channels only).
   * In the Ads view the composer composes ads, with a separate draft per
   * view so flipping never loses either text. */
  adView?: string;
  /** DM partner — enables outbound typing telemetry (TPN, PMs only). */
  partner?: string;
  /** Channel key when the conversation is a channel we are not live in. */
  rejoinKey?: string;
  placeholder: string;
  /** Byte limit for this conversation kind (live server VAR). */
  maxBytes: number;
}

export function Composer({
  session,
  convId,
  channelKey,
  channelMode,
  adView,
  partner,
  rejoinKey,
  placeholder,
  maxBytes,
}: ComposerProps) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [markdown, setMarkdown] = useState(savedMarkdownMode);
  const [eiconAnchor, setEiconAnchor] = useState<CardAnchor>();
  const [helpOpen, setHelpOpen] = useState(false);
  /** The extended formatting toolbar (M9 step 4), collapsed by default. */
  const [toolsOpen, setToolsOpen] = useState(false);
  const [adChosen, setAdChosen] = useState(false);
  const adCenterOpen = useUiStore((s) => s.adCenterOpen);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const online = session.sessionStatus === "online";
  // Room mode decides what a send is: ads-only rooms force LRP, chat-only
  // rooms force MSG, "both" offers the toggle (RMO re-gates this live).
  // The Ads view (M10) composes ads like an ads-only room does.
  const adsPossible = channelKey !== undefined && channelMode !== "chat";
  const adForced =
    channelKey !== undefined && (channelMode === "ads" || adView === "ads");
  const sendAsAd = adForced || (adsPossible && adChosen);

  // Separate chat/ad drafts across view flips (M10, spec §4): switching the
  // header's Show selector stashes the current text and restores the other
  // view's — neither draft is ever lost.
  const draftsRef = useRef({ chat: "", ad: "" });
  const prevViewRef = useRef(adView);
  useEffect(() => {
    const prev = prevViewRef.current;
    if (prev === adView) {
      return;
    }
    prevViewRef.current = adView;
    const prevKey = prev === "ads" ? ("ad" as const) : ("chat" as const);
    const nextKey = adView === "ads" ? ("ad" as const) : ("chat" as const);
    if (prevKey !== nextKey) {
      draftsRef.current[prevKey] = text;
      setText(draftsRef.current[nextKey]);
      requestAnimationFrame(autogrow);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- flip-only
  }, [adView]);
  // What actually goes on the wire — and what the server's limit measures.
  const wire = markdown ? mdToBBCode(text) : text;
  const bytes = utf8.encode(wire).length;
  const limitBytes = sendAsAd ? session.limits.lfrpMax : maxBytes;
  const pending = session.outbox.filter((item) => item.convId === convId);
  const previewEmote = parseEmote(wire);
  // Advisory lossiness check (M10): Markdown that reaches the wire as
  // literal text gets a heads-up next to the preview — never a block.
  const lossCount = useMemo(
    () => (markdown && text.trim() !== "" ? analyzeMarkdown(text).length : 0),
    [markdown, text],
  );
  // Case-insensitive: the icon_blacklist VAR carries lowercase names while
  // channel keys are canonical-case (audit).
  const iconsBlacklisted =
    channelKey !== undefined &&
    session.iconBlacklist.some(
      (key) => key.toLowerCase() === channelKey.toLowerCase(),
    );

  function autogrow() {
    const el = inputRef.current;
    if (el) {
      el.style.height = "auto";
      el.style.height = `${String(Math.min(el.scrollHeight, MAX_INPUT_HEIGHT_PX))}px`;
    }
  }

  // Outbound typing telemetry (PMs): "typing" while keys land, "paused"
  // after 3s idle, "clear" when the input empties or the message sends.
  // The session dedupes per recipient, so repeats never reach the wire.
  const typingTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const typingPushed = useRef<"clear" | "paused" | "typing">("clear");
  function pushTyping(status: "clear" | "paused" | "typing") {
    if (partner === undefined || !online) {
      return;
    }
    typingPushed.current = status;
    void gateway.cmd({
      identityId: session.identityId,
      action: "typing.set",
      d: { character: partner, status },
    });
  }

  function onTextChange(value: string) {
    setText(value);
    autogrow();
    if (partner === undefined) {
      return;
    }
    clearTimeout(typingTimer.current);
    if (value === "") {
      pushTyping("clear");
      return;
    }
    pushTyping("typing");
    typingTimer.current = setTimeout(() => {
      pushTyping("paused");
    }, 3000);
  }

  // Unmount (the shell keys this component by convId): stop the clock and
  // tell the old partner we stopped — otherwise they see "typing…" forever
  // (audit; only a sent PM would otherwise clear it).
  useEffect(() => {
    return () => {
      clearTimeout(typingTimer.current);
      if (typingPushed.current !== "clear") {
        pushTyping("clear");
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- unmount only
  }, []);

  function toggleMarkdown() {
    const next = !markdown;
    setMarkdown(next);
    try {
      localStorage.setItem(MARKDOWN_MODE_KEY, next ? "on" : "off");
    } catch {
      // Session-only preference then.
    }
  }

  /** Inserts at the caret (falls back to the end), keeping focus. */
  /** Fold used eicons into the Recents pref (picker inserts + sent text). */
  function recordRecents(names: string[]) {
    if (names.length === 0) {
      return;
    }
    void patchPrefs(session.identityId, {
      eiconRecents: mergeRecents(session.prefs.eiconRecents, names),
    });
  }

  function insertAtCaret(snippet: string) {
    const el = inputRef.current;
    const at = el?.selectionStart ?? text.length;
    const end = el?.selectionEnd ?? text.length;
    setText(text.slice(0, at) + snippet + text.slice(end));
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(at + snippet.length, at + snippet.length);
      autogrow();
    });
  }

  /** Wraps the selection (or empty caret) in an open/close marker pair. */
  function wrapPair(open: string, close: string) {
    const el = inputRef.current;
    if (!el) {
      return;
    }
    const from = el.selectionStart;
    const to = el.selectionEnd;
    const selected = text.slice(from, to);
    setText(text.slice(0, from) + open + selected + close + text.slice(to));
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(from + open.length, to + open.length);
    });
  }

  /** Wraps the selection (or empty caret) in a Markdown marker pair. */
  function wrapSelection(marker: string) {
    wrapPair(marker, marker);
  }

  /** Markdown-aware format wrapper: the md marker when Markdown is on and
   * one exists; the BBCode tag otherwise (the md dialect passes wrapper/
   * color tags through, so BBCode also works with Markdown on). */
  function wrapFormat(md: string | undefined, tag: string, param?: string) {
    if (markdown && md !== undefined) {
      wrapSelection(md);
      return;
    }
    wrapPair(`[${tag}${param !== undefined ? `=${param}` : ""}]`, `[/${tag}]`);
  }

  async function send() {
    const body = wire.trim();
    if (!body || busy) {
      return;
    }
    // Slash commands act on the raw typed text, before any translation.
    let slash;
    try {
      slash = parseSlash(text.trim());
    } catch (usage) {
      if (usage instanceof SlashUsageError) {
        setError(usage.message);
        return;
      }
      throw usage;
    }
    if (slash) {
      if (slash.type === "unknown") {
        setError(`Unknown command /${slash.name} — try /help`);
        return;
      }
      if (slash.type === "help") {
        setHelpOpen(true);
        setText("");
        requestAnimationFrame(autogrow);
        return;
      }
      if (channelKey === undefined) {
        setError("That command only works in channels");
        return;
      }
      const command =
        slash.type === "roll" || slash.type === "bottle"
          ? ({
              identityId: session.identityId,
              action: "channel.roll",
              d: {
                key: channelKey,
                dice: slash.type === "bottle" ? "bottle" : slash.dice,
              },
            } as const)
          : slash.type === "timeout"
            ? ({
                identityId: session.identityId,
                action: "channel.timeout",
                d: {
                  key: channelKey,
                  character: slash.character,
                  minutes: slash.minutes,
                },
              } as const)
            : slash.type === "setmode"
              ? ({
                  identityId: session.identityId,
                  action: "channel.mode",
                  d: { key: channelKey, mode: slash.mode },
                } as const)
              : slash.type === "banlist"
                ? ({
                    identityId: session.identityId,
                    action: "channel.banlist",
                    d: { key: channelKey },
                  } as const)
                : ({
                    identityId: session.identityId,
                    action: slash.action,
                    d: { key: channelKey, character: slash.character },
                  } as const);
      setBusy(true);
      setError(undefined);
      const ack = await gateway.cmd(command);
      setBusy(false);
      if (!ack.ok) {
        setError(ack.error ?? "Command failed");
        return;
      }
      setText("");
      requestAnimationFrame(autogrow);
      return;
    }
    setBusy(true);
    setError(undefined);
    const ack = await gateway.cmd({
      identityId: session.identityId,
      action: "msg.send",
      // The typed source rides along: a delayed send must recall to what
      // the user wrote, not the translated wire form.
      d: {
        convId,
        bbcode: body,
        ...(markdown ? { markdown: text.trim() } : {}),
        ...(sendAsAd ? { kind: "lrp" as const } : {}),
      },
    });
    setBusy(false);
    if (!ack.ok) {
      setError(ack.error ?? "Send failed");
      return;
    }
    // Typed eicons count as "used" too — this is also how Recents (and from
    // there Favorites) bootstrap before eicon search exists.
    recordRecents(eiconsIn(body));
    setText("");
    clearTimeout(typingTimer.current);
    pushTyping("clear");
    requestAnimationFrame(autogrow);
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void send();
      return;
    }
    // ArrowUp in an empty composer recalls the newest pending send (by
    // creation, not release — a shorter delay must not shadow an earlier
    // message; audit). The outbox row dies and the typed text comes back.
    if (event.key === "ArrowUp" && text === "" && pending.length > 0) {
      event.preventDefault();
      const newest = [...pending]
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .at(-1)!;
      void recall(newest.id);
    }
  }

  async function recall(outboxId: string) {
    const recalled = pending.find((item) => item.id === outboxId);
    const ack = await gateway.cmd({
      identityId: session.identityId,
      action: "outbox.recall",
      d: { outboxId },
    });
    if (ack.ok && ack.markdown !== undefined) {
      setText(ack.markdown);
      // A recalled ad re-sends as an ad, not a plain MSG (M6 audit): the
      // Ad toggle follows the recalled row's kind.
      if (recalled) {
        setAdChosen(recalled.kind === "lrp");
      }
      requestAnimationFrame(autogrow);
    }
  }

  function setDelay(sendDelaySeconds: number) {
    // Optimistic: prefs.updated converges every other tab.
    useSessionsStore
      .getState()
      .applySendDelay(session.identityId, sendDelaySeconds);
    void gateway.cmd({
      identityId: session.identityId,
      action: "prefs.set",
      d: { sendDelaySeconds },
    });
  }

  if (rejoinKey !== undefined) {
    return (
      <div className={styles.composer}>
        <div className={styles.joinPrompt}>
          You are not in this channel.
          <button
            className={styles.joinButton}
            disabled={!online}
            onClick={() => {
              void gateway.cmd({
                identityId: session.identityId,
                action: "channel.join",
                d: { key: rejoinKey },
              });
            }}
          >
            Join {rejoinKey}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.composer}>
      {error && (
        <p className={styles.composerError} role="alert">
          {error}
        </p>
      )}
      {markdown && text.trim() !== "" && (
        <div className={styles.previewPanel} data-testid="md-preview">
          <div className={styles.previewHead}>PREVIEW · markdown</div>
          <div
            className={`${styles.previewBody} ${previewEmote ? (styles.emoteBody ?? "") : ""}`}
          >
            {previewEmote ? (
              <>
                {session.character}
                {previewEmote.possessive ? "" : " "}
                <RichText bbcode={previewEmote.action} />
              </>
            ) : (
              <RichText bbcode={wire} />
            )}
          </div>
          {lossCount > 0 && (
            <div className={styles.previewLossiness}>
              ⚠{" "}
              {lossCount === 1
                ? "1 part will post as plain text"
                : `${String(lossCount)} parts will post as plain text`}{" "}
              — the preview shows exactly what goes out
            </div>
          )}
        </div>
      )}
      {helpOpen && (
        <HelpPanel
          onClose={() => {
            setHelpOpen(false);
          }}
        />
      )}
      {eiconAnchor && (
        <EiconPicker
          identityId={session.identityId}
          prefs={session.prefs}
          anchor={eiconAnchor}
          iconsBlacklisted={iconsBlacklisted}
          onInsert={(name) => {
            insertAtCaret(`[eicon]${name}[/eicon]`);
            recordRecents([name]);
          }}
          onClose={() => {
            setEiconAnchor(undefined);
          }}
        />
      )}
      <div className={styles.inputBar}>
        <span className={styles.inputGlyph} title="Attachments arrive later">
          +
        </span>
        <textarea
          ref={inputRef}
          className={styles.composerInput}
          rows={1}
          value={text}
          onChange={(e) => {
            onTextChange(e.target.value);
          }}
          onKeyDown={onKeyDown}
          placeholder={online ? placeholder : "Session is not connected"}
          disabled={!online}
          aria-label="Message"
        />
        <span className={styles.formatHints}>
          <button
            type="button"
            className={styles.formatHint}
            title={markdown ? "Bold (wrap in **)" : "Bold (wrap in [b])"}
            aria-label="Bold"
            onClick={() => {
              wrapFormat("**", "b");
            }}
          >
            **B**
          </button>
          <button
            type="button"
            className={styles.formatHint}
            title="Code (wrap in `)"
            aria-label="Code"
            disabled={!markdown}
            onClick={() => {
              wrapSelection("`");
            }}
          >
            `code`
          </button>
          <button
            type="button"
            className={`${styles.formatHint} ${toolsOpen ? (styles.formatHintOn ?? "") : ""}`}
            title="More formatting"
            aria-label="More formatting"
            aria-pressed={toolsOpen}
            onClick={() => {
              setToolsOpen((open) => !open);
            }}
          >
            Aa
          </button>
          {toolsOpen && (
            <>
              <button
                type="button"
                className={styles.formatHint}
                title={markdown ? "Italic (wrap in *)" : "Italic ([i])"}
                aria-label="Italic"
                onClick={() => {
                  wrapFormat("*", "i");
                }}
              >
                <i>i</i>
              </button>
              <button
                type="button"
                className={styles.formatHint}
                title="Underline ([u] — BBCode works in both modes)"
                aria-label="Underline"
                onClick={() => {
                  wrapFormat(undefined, "u");
                }}
              >
                <u>u</u>
              </button>
              <button
                type="button"
                className={styles.formatHint}
                title={
                  markdown
                    ? "Strikethrough (wrap in ~~)"
                    : "Strikethrough ([s])"
                }
                aria-label="Strikethrough"
                onClick={() => {
                  wrapFormat("~~", "s");
                }}
              >
                <s>s</s>
              </button>
              <select
                className={styles.formatSelect}
                title="Wrap in a color"
                aria-label="Color"
                value=""
                onChange={(event) => {
                  if (event.target.value !== "") {
                    wrapFormat(undefined, "color", event.target.value);
                  }
                }}
              >
                <option value="">color…</option>
                {BB_COLORS.map((color) => (
                  <option key={color} value={color}>
                    {color}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className={styles.formatHint}
                title="Show markup literally ([noparse])"
                aria-label="Noparse"
                onClick={() => {
                  wrapFormat(undefined, "noparse");
                }}
              >
                [np]
              </button>
            </>
          )}
          <button
            type="button"
            className={styles.formatHint}
            title="Commands & formatting reference (/help)"
            aria-label="Help"
            onClick={() => {
              setHelpOpen(true);
            }}
          >
            ?
          </button>
          <button
            type="button"
            className={styles.formatHint}
            title="Insert an eicon"
            aria-label="Insert eicon"
            onClick={(event) => {
              if (eiconAnchor) {
                setEiconAnchor(undefined);
                return;
              }
              const rect = event.currentTarget.getBoundingClientRect();
              setEiconAnchor({
                top: rect.top,
                left: rect.left,
                bottom: rect.bottom,
                right: rect.right,
              });
            }}
          >
            ☺
          </button>
          <span className={styles.hintDivider} aria-hidden />
          <button
            type="button"
            className={`${styles.formatHint} ${adCenterOpen ? (styles.formatHintOn ?? "") : ""}`}
            title="Your ad library — write once, post anywhere"
            aria-label="Open the Ad Center"
            onClick={() => {
              useUiStore.getState().setAdCenterOpen(true);
            }}
          >
            ▤ Ad
          </button>
        </span>
      </div>
      <div className={styles.composerFooter}>
        <button
          type="button"
          className={`${styles.mdToggle} ${markdown ? (styles.mdToggleOn ?? "") : ""}`}
          onClick={toggleMarkdown}
          title={
            markdown
              ? "Markdown on — sends BBCode"
              : "Markdown off — raw BBCode"
          }
        >
          Ⓜ Markdown
        </button>
        {adsPossible && (
          <button
            type="button"
            className={`${styles.mdToggle} ${sendAsAd ? (styles.mdToggleOn ?? "") : ""}`}
            onClick={() => {
              setAdChosen(!adChosen);
            }}
            disabled={adForced}
            title={
              adForced
                ? channelMode === "ads"
                  ? "This room only accepts roleplay ads"
                  : "The Ads view composes ads — set Show to Chat or Both for chat"
                : sendAsAd
                  ? "Sending as a roleplay ad — each channel takes one ad per window"
                  : "Send as a roleplay ad"
            }
            aria-pressed={sendAsAd}
          >
            ♥ Ad
          </button>
        )}
        <select
          className={styles.delaySelect}
          value={session.sendDelaySeconds}
          aria-label="Send delay"
          title="Hold sends in the server outbox — ArrowUp recalls"
          onChange={(e) => {
            setDelay(Number(e.target.value));
          }}
        >
          <option value={0}>instant</option>
          <option value={10}>10s delay</option>
          <option value={30}>30s delay</option>
          <option value={60}>60s delay</option>
        </select>
        <span>Enter to send · Shift+Enter for newline</span>
        <span
          className={`${styles.charCounter} ${bytes > limitBytes ? (styles.charCounterOver ?? "") : ""}`}
        >
          {bytes}/{limitBytes}
        </span>
      </div>
    </div>
  );
}
