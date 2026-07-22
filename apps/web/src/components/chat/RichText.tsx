// BBCode → styled spans (COMPONENTS.md §7): the one render path for message
// bodies, system lines, channel descriptions, statusmsg — and, in M4 step 4,
// the composer preview, so what you preview is exactly what recipients see.
// Structure comes from the shared subset AST; plain text runs get the inline
// token pass (links, @name, #channel). [icon]/[eicon] render as name chips
// until step 3 brings inline images.

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { parseBBCode, type BBNode } from "@emberchat/markdown-bbcode";
import { avatarUrl, eiconUrl } from "../../lib/avatar.js";
import { parseCharacterUrl } from "../../lib/character-url.js";
import { chipHost, chipLabel, resolvePreview } from "../../lib/link-preview.js";
import {
  openPreviewFrom,
  useLinkPreviewStore,
} from "../../stores/link-preview.js";
import { useNavigate } from "react-router";
import { gateway } from "../../gateway/socket.js";
import { channelPath } from "../../lib/routes.js";
import { openCardFrom } from "../../stores/profile.js";
import { useSessionsStore, useUserPrefs } from "../../stores/sessions.js";
import { useUiStore } from "../../stores/ui.js";
import { spoilerSegments, textTokens } from "./rich-text.js";
import styles from "./chat.module.css";

/**
 * How an intercepted f-list.net/c/<name> link opens its character (#214).
 * The default matches a chat `[user]` click — the mini card anchored to the
 * link. The profile viewer overrides it (ProfileLinkProvider) to swap the
 * viewer instead, since the popover would layer below the modal.
 */
export type ProfileLinkOpener = (element: Element, name: string) => void;

const ProfileLinkContext = createContext<ProfileLinkOpener>(openCardFrom);

export const ProfileLinkProvider = ProfileLinkContext.Provider;

export function RichText({ bbcode }: { bbcode: string }) {
  // Memoized: the log re-renders far more often than messages change, and
  // parsing every visible message per render is exactly the hot path a
  // hostile long message would exploit (audit).
  const nodes = useMemo(() => parseBBCode(bbcode), [bbcode]);
  return <>{renderNodes(nodes, "r")}</>;
}

/** Hook for the profile renderer (M8): claim a node (profile blocks) or
 * return undefined to fall through to the shared inline rendering. */
export type ExtraNodeRenderer = (
  node: BBNode,
  key: string,
) => ReactNode | undefined;

/** Exported for the profile BBCode renderer (M8): profile blocks wrap these
 * same inline nodes so chat and profiles render text identically. */
export function renderNodes(
  nodes: readonly BBNode[],
  keyBase: string,
  extra?: ExtraNodeRenderer,
): ReactNode[] {
  return nodes.map((node, index) => {
    const key = `${keyBase}.${String(index)}`;
    return extra?.(node, key) ?? renderNode(node, key, extra);
  });
}

const WRAPPER_CLASS: Record<string, string | undefined> = {
  b: styles.bbB,
  i: styles.bbI,
  u: styles.bbU,
  s: styles.bbS,
  sup: styles.bbSup,
  sub: styles.bbSub,
};

function renderNode(
  node: BBNode,
  key: string,
  extra?: ExtraNodeRenderer,
): ReactNode {
  switch (node.type) {
    case "text":
      return renderText(node.text, key);
    case "wrapper":
      return (
        <span key={key} className={WRAPPER_CLASS[node.tag] ?? ""}>
          {renderNodes(node.children, key, extra)}
        </span>
      );
    case "color":
      return (
        <span key={key} className={styles[`bbc-${node.color}`] ?? ""}>
          {renderNodes(node.children, key, extra)}
        </span>
      );
    case "url":
      return (
        <LinkChip key={key} href={node.href}>
          {renderNodes(node.children, key, extra)}
        </LinkChip>
      );
    case "name":
      // [user] opens the mini profile card (M8) — the f-list.net website
      // link lives in the context menu / full viewer instead.
      return node.tag === "user" ? (
        <button
          key={key}
          type="button"
          className={`${styles.nameButton ?? ""} ${styles.bodyMention}`}
          onClick={(event) => {
            openCardFrom(event.currentTarget, node.name);
          }}
        >
          {node.name}
        </button>
      ) : (
        <InlineIcon key={key} tag={node.tag} name={node.name} />
      );
    case "noparse":
      return (
        <span key={key} className={styles.bodyCode}>
          {node.text}
        </span>
      );
    case "spoiler":
      // Incoming [spoiler] from other clients (#204): same covered bar as the
      // `||…||` spelling, but wrapping full markup (text, eicons, …).
      return (
        <Spoiler key={key}>{renderNodes(node.children, key, extra)}</Spoiler>
      );
    // Profile-dialect nodes never occur in chat parses; if one arrives
    // unclaimed (no `extra`), degrade to unstyled content — never crash.
    case "block":
    case "collapse":
      return <span key={key}>{renderNodes(node.children, key, extra)}</span>;
    // Profile inline images never occur in a chat parse; the profile renderer
    // claims them via `extra`. Anything reaching here degrades silently.
    case "img":
    case "hr":
      return null;
  }
}

function renderText(text: string, keyBase: string): ReactNode[] {
  // `||…||` spoiler pass first (#205): covered segments reveal on click.
  // Wire-plain pipes, so this is purely a viewer-side treatment.
  const segments = spoilerSegments(text);
  if (segments.some((segment) => segment.spoiler)) {
    return segments.map((segment, index) => {
      const key = `${keyBase}.sp${String(index)}`;
      return segment.spoiler ? (
        <Spoiler key={key}>{renderTokens(segment.text, key)}</Spoiler>
      ) : (
        <span key={key}>{renderTokens(segment.text, key)}</span>
      );
    });
  }
  return renderTokens(text, keyBase);
}

/** A covered bar (background = text color, content transparent) until
 * clicked — Discord-style; click again re-covers. */
function Spoiler({ children }: { children: ReactNode }) {
  const [revealed, setRevealed] = useState(false);
  return (
    <span
      role="button"
      tabIndex={0}
      aria-pressed={revealed}
      title={revealed ? "Hide spoiler" : "Show spoiler"}
      className={`${styles.spoiler} ${revealed ? (styles.spoilerRevealed ?? "") : ""}`}
      onClick={() => {
        setRevealed((on) => !on);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          setRevealed((on) => !on);
        }
      }}
    >
      {children}
    </span>
  );
}

function renderTokens(text: string, keyBase: string): ReactNode[] {
  return textTokens(text).map((token, index) => {
    const key = `${keyBase}.${String(index)}`;
    switch (token.kind) {
      case "plain":
        return token.text;
      case "link":
        return <LinkChip key={key} href={token.href} />;
      case "mention":
        return (
          <span key={key} className={styles.bodyMention}>
            @{token.name}
          </span>
        );
      case "channel":
        return <ChannelChip key={key} name={token.name} />;
    }
  });
}

/**
 * LinkChip (COMPONENTS-link-preview-eicon.md §1): the one rendering for
 * URLs in message bodies — `[url]` tags (children = the label) and
 * autolinked plain text (no children → derived label + mono host suffix).
 * The ▣ glyph marks previewable media links; behavior follows the
 * linkPreviewMode pref — click mode hijacks plain clicks on *media* links
 * only (Ctrl/Cmd/middle click always navigates), hover mode opens after
 * ~250ms, off = plain links everywhere.
 */
const HOVER_DELAY_MS = 250;

/** A `#Channel` text token: click joins and navigates (the cursor promised
 * an action since M4; the M6 audit called the missing handler out). Only
 * official channels appear as #tokens, so the name doubles as the key.
 * Join-while-joined is a harmless no-op; the route canonicalizes the
 * moment the JCH echo lands. */
function ChannelChip({ name }: { name: string }) {
  const navigate = useNavigate();
  return (
    <button
      type="button"
      className={`${styles.bodyChannel} ${styles.nameButton}`}
      title={`Join #${name}`}
      onClick={() => {
        const identityId = useUiStore.getState().activeIdentityId;
        if (identityId === undefined) {
          return;
        }
        const session = useSessionsStore.getState().sessions[identityId];
        if (!session?.synced) {
          return;
        }
        void gateway.cmd({
          identityId,
          action: "channel.join",
          d: { key: name },
        });
        void navigate(channelPath(session.character, name));
      }}
    >
      #{name}
    </button>
  );
}

function LinkChip({ href, children }: { href: string; children?: ReactNode }) {
  const prefs = useUserPrefs();
  const mode = prefs.linkPreviewMode;
  const source = resolvePreview(href, prefs.imagePreviewHosts);
  const character = useMemo(() => parseCharacterUrl(href), [href]);
  const openProfile = useContext(ProfileLinkContext);
  const active = useLinkPreviewStore((s) => s.preview?.href === href);
  const hoverTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => {
    return () => {
      clearTimeout(hoverTimer.current);
    };
  }, []);

  const previewable = source !== undefined && mode !== "off";
  const host = chipHost(href);
  return (
    <a
      className={`${styles.linkChip} ${active ? (styles.linkChipActive ?? "") : ""}`}
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      onClick={(event) => {
        // A plain click on an f-list.net/c/<name> link opens the in-app
        // profile viewer (#214); modified clicks (Ctrl/Cmd/Shift, and
        // middle-click, which fires onAuxClick not onClick) follow the URL.
        if (
          character !== undefined &&
          !event.ctrlKey &&
          !event.metaKey &&
          !event.shiftKey
        ) {
          event.preventDefault();
          openProfile(event.currentTarget, character);
          return;
        }
        if (
          previewable &&
          mode === "click" &&
          !event.ctrlKey &&
          !event.metaKey
        ) {
          // Plain click previews; modified clicks follow the URL (§2).
          event.preventDefault();
          openPreviewFrom(event.currentTarget, source, href, "click");
        }
      }}
      onMouseEnter={(event) => {
        if (!previewable || mode !== "hover") {
          return;
        }
        const element = event.currentTarget;
        hoverTimer.current = setTimeout(() => {
          openPreviewFrom(element, source, href, "hover");
        }, HOVER_DELAY_MS);
      }}
      onMouseLeave={() => {
        if (mode !== "hover") {
          return;
        }
        clearTimeout(hoverTimer.current);
        const store = useLinkPreviewStore.getState();
        if (store.preview?.href === href) {
          store.close();
        }
      }}
    >
      <span className={styles.linkChipLabel}>
        {children ?? chipLabel(href)}
      </span>
      <span className={styles.linkChipGlyph} aria-hidden>
        {previewable ? "▣" : "↗"}
      </span>
      {host !== "" && <span className={styles.linkChipHost}>[{host}]</span>}
    </a>
  );
}

/**
 * Inline [icon]/[eicon] (decisions.md §8): fixed 60px box with explicit
 * dimensions so virtualized rows measure right before the image loads;
 * hotlinked + lazy like avatars. [icon] is the character's avatar and links
 * to their profile. A name outside the safe charset falls back to a chip.
 * Eicons obey the Appearance prefs (M5): display mode (inline vs name chip
 * with hover preview) and the animate toggle (off = frozen first frame).
 * [icon] avatars are static images — the prefs don't apply.
 */
function InlineIcon({ tag, name }: { tag: "icon" | "eicon"; name: string }) {
  const prefs = useUserPrefs();
  const src = tag === "eicon" ? eiconUrl(name) : avatarUrl(name);
  if (src === undefined) {
    return (
      <span className={styles.bodyCode} title={`[${tag}]`}>
        {name}
      </span>
    );
  }
  if (tag === "icon") {
    return (
      <a
        href={`https://www.f-list.net/c/${encodeURIComponent(name)}`}
        target="_blank"
        rel="noreferrer noopener"
      >
        <img
          className={styles.bodyEicon}
          src={src}
          alt={name}
          title={name}
          width={60}
          height={60}
          loading="lazy"
        />
      </a>
    );
  }
  if (prefs.eiconDisplay === "name") {
    return <EiconChip name={name} src={src} animate={prefs.animateEicons} />;
  }
  return <EiconImage name={name} src={src} animate={prefs.animateEicons} />;
}

function EiconImage({
  name,
  src,
  animate,
}: {
  name: string;
  src: string;
  animate: boolean;
}) {
  return animate ? (
    <img
      className={styles.bodyEicon}
      src={src}
      alt={name}
      title={name}
      width={60}
      height={60}
      loading="lazy"
    />
  ) : (
    <FrozenImage name={name} src={src} />
  );
}

/**
 * The animate-off rendering: draw the image's current frame onto a canvas
 * the moment it loads — with a GIF that is the first frame, frozen. No
 * crossOrigin attribute on purpose: static.f-list.net serves no CORS
 * headers, so requesting them would fail the load; a tainted canvas is fine
 * (we display, never read pixels back).
 */
function FrozenImage({ name, src }: { name: string; src: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    let cancelled = false;
    const img = new Image();
    img.onload = () => {
      if (cancelled) {
        return;
      }
      canvasRef.current
        ?.getContext("2d")
        ?.drawImage(img, 0, 0, EICON_BOX, EICON_BOX);
    };
    img.src = src;
    return () => {
      cancelled = true;
    };
  }, [src]);
  return (
    <canvas
      ref={canvasRef}
      className={styles.bodyEicon}
      width={EICON_BOX}
      height={EICON_BOX}
      title={name}
      role="img"
      aria-label={name}
    />
  );
}

const EICON_BOX = 60;

/** Name-only display mode: a chip that previews the eicon on hover. */
function EiconChip({
  name,
  src,
  animate,
}: {
  name: string;
  src: string;
  animate: boolean;
}) {
  const [hover, setHover] = useState(false);
  return (
    <span
      className={styles.eiconChip}
      onMouseEnter={() => {
        setHover(true);
      }}
      onMouseLeave={() => {
        setHover(false);
      }}
    >
      <span className={styles.bodyCode} title="[eicon]">
        {name}
      </span>
      {hover && (
        <span className={styles.eiconPreview}>
          <EiconImage name={name} src={src} animate={animate} />
        </span>
      )}
    </span>
  );
}
