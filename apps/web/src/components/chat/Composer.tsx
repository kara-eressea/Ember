// Composer (COMPONENTS.md §8): Markdown composing with a live preview panel
// rendered through the same RichText pipeline as the log — what you preview
// is exactly what recipients see. The Ⓜ toggle switches Markdown mode (off =
// raw BBCode passthrough, the M1 behavior); Enter sends, Shift+Enter breaks
// the line. The byte counter counts the translated wire form — that is what
// the server measures.

import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { analyzeMarkdown, mdToBBCode } from "@emberchat/markdown-bbcode";
import { gateway } from "../../gateway/socket.js";
import {
  useSessionsStore,
  type IdentitySession,
} from "../../stores/sessions.js";
import type { CardAnchor } from "../../stores/profile.js";
import { useUiStore } from "../../stores/ui.js";
import { patchPrefs } from "../prefs/patch.js";
import { countdownLabel } from "./composer-toolbar.js";
import {
  insertAt,
  isSlashListMode,
  newestPending,
  slashKeyAction,
  stripColor,
  wrapRange,
} from "./composer-edit.js";
import { ComposerToolbar } from "./ComposerToolbar.js";
import {
  textareaHandle,
  type AnyKeyEvent,
  type ComposerInputHandle,
} from "./composer-input.js";
import { eiconsIn, mergeRecents } from "./eicon-recents.js";
import { EiconPicker } from "./EiconPicker.js";
import { HelpPanel } from "./HelpPanel.js";
import { roleFor } from "./member-roles.js";
import { parseEmote } from "./rich-text.js";
import { RichText } from "./RichText.js";
import {
  parseSlash,
  suggestCommands,
  SlashUsageError,
  type SlashHint,
} from "./slash.js";
import { SlashAutocomplete } from "./SlashAutocomplete.js";
import styles from "./chat.module.css";

/** The textarea grows with its content up to this, then scrolls. */
const MAX_INPUT_HEIGHT_PX = 160;

const MARKDOWN_MODE_KEY = "emberchat.composeMarkdown";

// The inline-rendering CodeMirror input (#226, prefs.inlineComposer) loads
// on demand — the editor chunk stays off the login/critical path and users
// on the classic textarea never download it.
const InlineEditor = lazy(() => import("./InlineEditor.js"));

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
  /** Owner-first oplist of the active channel — gates moderator commands in
   * the slash autocomplete (#235). Empty/omitted in DMs. */
  oplist?: readonly string[];
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
  oplist,
  channelMode,
  adView,
  partner,
  rejoinKey,
  placeholder,
  maxBytes,
}: ComposerProps) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  // Synchronous correctness guard against double-send (#267). `busy` is
  // captured at render time, so two Enter events in one frame both see
  // busy=false and both dispatch. This ref flips synchronously before any
  // dispatch and clears on ack/error, so a second Enter in the same frame is
  // a no-op. `busy` stays as the UI-facing state; this is the latch.
  const sendingRef = useRef(false);
  const [error, setError] = useState<string>();
  const [markdown, setMarkdown] = useState(savedMarkdownMode);
  const [eiconAnchor, setEiconAnchor] = useState<CardAnchor>();
  const [helpOpen, setHelpOpen] = useState(false);
  const [adChosen, setAdChosen] = useState(false);
  // Slash autocomplete (#235): the highlighted row, and an Escape flag that
  // keeps the popover shut until the leading token changes again.
  const [slashActive, setSlashActive] = useState(0);
  const [slashDismissed, setSlashDismissed] = useState(false);
  const adCenterOpen = useUiStore((s) => s.adCenterOpen);
  // Everything programs against the textarea-shaped handle; textareaRef
  // only exists for the legacy path's autogrow.
  const inline = session.prefs.inlineComposer;
  const inputRef = useRef<ComposerInputHandle>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
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
  // Queued-send countdown chips (footer-left, #205): re-render once a
  // second only while something is actually parked for this conversation;
  // the labels read the clock directly at render time.
  const [, tick] = useState(0);
  useEffect(() => {
    if (pending.length === 0) {
      return;
    }
    const timer = setInterval(() => {
      tick((t) => t + 1);
    }, 1000);
    return () => {
      clearInterval(timer);
    };
  }, [pending.length]);
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

  // Slash autocomplete list for the current text. Moderator entries are gated
  // on the identity's role in this channel — the same primitive the header's
  // room controls use (roleFor + chatop). DMs have no channel, so channel-only
  // commands drop out entirely.
  const canModerate =
    channelKey !== undefined &&
    (roleFor(session.character, oplist ?? []) !== null || session.chatop);
  const slashSuggestions = useMemo(
    () =>
      suggestCommands(text, {
        inChannel: channelKey !== undefined,
        canModerate,
      }),
    [text, channelKey, canModerate],
  );
  // Popover visibility is render-derived; keyboard selection reads the live
  // input value in onKeyDown (below) to stay correct under fast input.
  const showSlash = !slashDismissed && slashSuggestions.length > 0;
  const slashIndex = Math.min(slashActive, slashSuggestions.length - 1);

  function completeSlash(hint: SlashHint) {
    const next = `/${hint.name} `;
    setSlashActive(0);
    const el = inputRef.current;
    if (el?.applyEdit) {
      // Inline editor: text + caret land in one synchronous transaction —
      // a deferred restore could collapse a selection the user makes next.
      el.applyEdit(next, next.length, next.length);
      setText(next);
      return;
    }
    setText(next);
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(next.length, next.length);
      autogrow();
    });
  }

  function autogrow() {
    const el = textareaRef.current;
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
    // Typing reopens the autocomplete (Escape only shuts it for the text as
    // it stood) and re-anchors the selection to the top of the list.
    setSlashDismissed(false);
    setSlashActive(0);
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
    const edit = insertAt(text, at, end, snippet);
    if (el?.applyEdit) {
      el.applyEdit(edit.text, edit.selStart, edit.selEnd);
      setText(edit.text);
      return;
    }
    setText(edit.text);
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(edit.selStart, edit.selEnd);
      autogrow();
    });
  }

  /** Wraps the selection (or empty caret) in an open/close marker pair. */
  function wrapPair(open: string, close: string) {
    const el = inputRef.current;
    if (!el) {
      return;
    }
    const edit = wrapRange(
      text,
      el.selectionStart,
      el.selectionEnd,
      open,
      close,
    );
    if (el.applyEdit) {
      el.applyEdit(edit.text, edit.selStart, edit.selEnd);
      setText(edit.text);
      return;
    }
    setText(edit.text);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(edit.selStart, edit.selEnd);
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

  /** "✕ Remove colour" (toolbar popover): strip any [color] tags from the
   * selected run — the inverse of the swatch wrap, kept deliberately
   * simple (tag surgery, contents untouched). */
  function removeColor() {
    const el = inputRef.current;
    if (!el) {
      return;
    }
    const edit = stripColor(text, el.selectionStart, el.selectionEnd);
    if (el.applyEdit) {
      el.applyEdit(edit.text, edit.selStart, edit.selEnd);
      setText(edit.text);
      return;
    }
    setText(edit.text);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(edit.selStart, edit.selEnd);
    });
  }

  async function send() {
    // Read the live input value rather than the closured `text` state: a fast
    // Enter (or programmatic input) can fire before React re-renders, and
    // sending stale text would fire the wrong message or mis-route a command
    // (#235 audit). Everything below derives from this one source of truth.
    const source = inputRef.current?.value ?? text;
    const body = (markdown ? mdToBBCode(source) : source).trim();
    // The ref latch is the synchronous guard (busy is a stale render capture,
    // #267); it is set below before any dispatch and cleared in `finally`.
    if (!body || busy || sendingRef.current) {
      return;
    }
    sendingRef.current = true;
    try {
      await sendInner(source, body);
    } finally {
      sendingRef.current = false;
    }
  }

  async function sendInner(source: string, body: string) {
    // Slash commands act on the raw typed text, before any translation.
    let slash;
    try {
      slash = parseSlash(source.trim());
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
        ...(markdown ? { markdown: source.trim() } : {}),
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

  // One handler for both inputs. `liveText` is the input's value *at event
  // time* (textarea: currentTarget.value; CodeMirror: the live doc) — the
  // stale-state contract from the #235 audit holds identically on both.
  function onKeyDown(event: AnyKeyEvent, liveText: string) {
    // Slash autocomplete keyboard (#235). The decision reads the *live*
    // textarea value, not the closured `text` state — fast programmatic input
    // (and quick typists) can fire keydown before React has re-rendered with
    // the new value, and a stale read would misfire Enter (completing instead
    // of running a command, or swallowing a send). Escape closes the popover
    // from any state; arrow/Tab/Enter selection applies only while the command
    // word is being chosen (list mode) — in signature-hint mode Enter sends.
    const liveSuggestions = suggestCommands(liveText, {
      inChannel: channelKey !== undefined,
      canModerate,
    });
    const liveShow = !slashDismissed && liveSuggestions.length > 0;
    if (liveShow && event.key === "Escape") {
      event.preventDefault();
      setSlashDismissed(true);
      return;
    }
    const liveListMode = liveShow && isSlashListMode(liveText);
    if (liveListMode) {
      const count = liveSuggestions.length;
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setSlashActive((i) => (Math.min(i, count - 1) + 1) % count);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setSlashActive((i) => (Math.min(i, count - 1) + count - 1) % count);
        return;
      }
      const hint = liveSuggestions[Math.min(slashActive, count - 1)];
      // Tab always completes the highlighted command (adding a trailing space
      // to type args into). Enter completes too — unless the highlighted
      // command is already exactly what's typed, in which case Enter runs it
      // (so a bare "/help" or "/bottle" still fires on the first Enter).
      const action = slashKeyAction(event.key, liveText, hint?.name);
      if (action === "complete") {
        event.preventDefault();
        if (hint) {
          completeSlash(hint);
        }
        return;
      }
      // action === "run" falls through to the Enter-send path below.
    }
    // Toolbar shortcuts (spec §3): mirrored in the button tooltips.
    if (event.ctrlKey || event.metaKey) {
      const key = event.key.toLowerCase();
      if (key === "b" || key === "i" || key === "u") {
        event.preventDefault();
        if (key === "b") {
          wrapFormat("**", "b");
        } else if (key === "i") {
          wrapFormat("*", "i");
        } else {
          wrapFormat(undefined, "u");
        }
        return;
      }
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void send();
      return;
    }
    // ArrowUp in an empty composer recalls the newest pending send (by
    // creation, not release — a shorter delay must not shadow an earlier
    // message; audit). The outbox row dies and the typed text comes back.
    if (event.key === "ArrowUp" && liveText === "" && pending.length > 0) {
      event.preventDefault();
      const newest = newestPending(pending);
      if (newest) {
        void recall(newest.id);
      }
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

  /** Cancel (countdown chip): recall the parked send and drop the text —
   * unlike Edit, nothing comes back into the input. */
  function cancelPending(outboxId: string) {
    void gateway.cmd({
      identityId: session.identityId,
      action: "outbox.recall",
      d: { outboxId },
    });
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
      {markdown && !inline && text.trim() !== "" && (
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
      <div className={styles.composerField}>
        {showSlash && (
          <SlashAutocomplete
            suggestions={slashSuggestions}
            activeIndex={slashIndex}
            onHover={setSlashActive}
            onSelect={completeSlash}
          />
        )}
        <div className={styles.messageBox}>
          <ComposerToolbar
            markdown={markdown}
            disabled={!online}
            text={text}
            inputRef={inputRef}
            sendDelaySeconds={session.sendDelaySeconds}
            onSetDelay={setDelay}
            onWrapFormat={wrapFormat}
            onWrapSelection={wrapSelection}
            onReplaceSelection={insertAtCaret}
            onRemoveColor={removeColor}
            onToggleEicon={(anchor) => {
              setEiconAnchor(eiconAnchor ? undefined : anchor);
            }}
            onOpenHelp={() => {
              setHelpOpen(true);
            }}
          />
          <div className={styles.inputBar}>
            <span
              className={styles.inputGlyph}
              title="Attachments arrive later"
            >
              +
            </span>
            {inline ? (
              // While the editor chunk loads, the classic textarea stands in
              // so the composer never blanks (a beat later the editor mounts
              // with the same value/handle).
              <Suspense
                fallback={
                  <textarea
                    className={styles.composerInput}
                    rows={1}
                    value={text}
                    readOnly
                    aria-label="Message"
                  />
                }
              >
                <InlineEditor
                  value={text}
                  disabled={!online}
                  placeholder={
                    online ? placeholder : "Session is not connected"
                  }
                  onChange={onTextChange}
                  onKeyDown={onKeyDown}
                  handleRef={inputRef}
                  ariaLabel="Message"
                />
              </Suspense>
            ) : (
              <textarea
                ref={(el) => {
                  textareaRef.current = el;
                  inputRef.current = textareaHandle(el);
                }}
                className={styles.composerInput}
                rows={1}
                value={text}
                onChange={(e) => {
                  onTextChange(e.target.value);
                }}
                onKeyDown={(e) => {
                  onKeyDown(e, e.currentTarget.value);
                }}
                placeholder={online ? placeholder : "Session is not connected"}
                disabled={!online}
                aria-label="Message"
              />
            )}
          </div>
        </div>
      </div>
      <div className={styles.composerFooter}>
        <span className={styles.footerGroup}>
          <button
            type="button"
            className={`${styles.mdToggle} ${markdown ? (styles.mdToggleOn ?? "") : ""}`}
            onClick={toggleMarkdown}
            title={
              markdown
                ? "Formatting on — your **bold**, *italic* and links are styled when you send"
                : "Formatting off — sends exactly what you typed"
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
          <button
            type="button"
            className={`${styles.mdToggle} ${adCenterOpen ? (styles.mdToggleOn ?? "") : ""}`}
            title="Your ad library — write once, post anywhere"
            aria-label="Open the Ad Center"
            onClick={() => {
              useUiStore.getState().setAdCenterOpen(true);
            }}
          >
            ▤ Ad Center
          </button>
          {pending.map((item) => (
            <span key={item.id} className={styles.countdownChip}>
              <span className={styles.countdownTime}>
                ⏱{" "}
                {countdownLabel(
                  Math.ceil(
                    (new Date(item.releaseAt).getTime() - Date.now()) / 1000,
                  ),
                )}
              </span>
              <button
                type="button"
                className={styles.chipAction}
                title="Pull it back into the input to edit"
                onClick={() => {
                  void recall(item.id);
                }}
              >
                Edit
              </button>
              <button
                type="button"
                className={styles.chipAction}
                title="Cancel this send"
                onClick={() => {
                  cancelPending(item.id);
                }}
              >
                Cancel
              </button>
            </span>
          ))}
        </span>
        <span className={styles.footerGroup}>
          <span>Enter to send · ⇧⏎ newline</span>
          <span
            className={`${styles.charCounter} ${bytes > limitBytes ? (styles.charCounterOver ?? "") : ""}`}
          >
            {bytes}/{limitBytes}
          </span>
        </span>
      </div>
    </div>
  );
}
