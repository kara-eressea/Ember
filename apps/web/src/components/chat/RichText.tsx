// BBCode → styled spans (COMPONENTS.md §7): the one render path for message
// bodies, system lines, channel descriptions, statusmsg — and, in M4 step 4,
// the composer preview, so what you preview is exactly what recipients see.
// Structure comes from the shared subset AST; plain text runs get the inline
// token pass (links, @name, #channel). [icon]/[eicon] render as name chips
// until step 3 brings inline images.

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { parseBBCode, type BBNode } from "@emberchat/markdown-bbcode";
import { avatarUrl, eiconUrl } from "../../lib/avatar.js";
import { useUserPrefs } from "../../stores/sessions.js";
import { textTokens } from "./rich-text.js";
import styles from "./chat.module.css";

export function RichText({ bbcode }: { bbcode: string }) {
  // Memoized: the log re-renders far more often than messages change, and
  // parsing every visible message per render is exactly the hot path a
  // hostile long message would exploit (audit).
  const nodes = useMemo(() => parseBBCode(bbcode), [bbcode]);
  return <>{renderNodes(nodes, "r")}</>;
}

function renderNodes(nodes: readonly BBNode[], keyBase: string): ReactNode[] {
  return nodes.map((node, index) =>
    renderNode(node, `${keyBase}.${String(index)}`),
  );
}

const WRAPPER_CLASS: Record<string, string | undefined> = {
  b: styles.bbB,
  i: styles.bbI,
  u: styles.bbU,
  s: styles.bbS,
  sup: styles.bbSup,
  sub: styles.bbSub,
};

function renderNode(node: BBNode, key: string): ReactNode {
  switch (node.type) {
    case "text":
      return renderText(node.text, key);
    case "wrapper":
      return (
        <span key={key} className={WRAPPER_CLASS[node.tag] ?? ""}>
          {renderNodes(node.children, key)}
        </span>
      );
    case "color":
      return (
        <span key={key} className={styles[`bbc-${node.color}`] ?? ""}>
          {renderNodes(node.children, key)}
        </span>
      );
    case "url":
      return (
        <a
          key={key}
          className={styles.bodyLink}
          href={node.href}
          target="_blank"
          rel="noreferrer noopener"
        >
          {renderNodes(node.children, key)}
        </a>
      );
    case "name":
      return node.tag === "user" ? (
        <a
          key={key}
          className={styles.bodyMention}
          href={`https://www.f-list.net/c/${encodeURIComponent(node.name)}`}
          target="_blank"
          rel="noreferrer noopener"
        >
          {node.name}
        </a>
      ) : (
        <InlineIcon key={key} tag={node.tag} name={node.name} />
      );
    case "noparse":
      return (
        <span key={key} className={styles.bodyCode}>
          {node.text}
        </span>
      );
  }
}

function renderText(text: string, keyBase: string): ReactNode[] {
  return textTokens(text).map((token, index) => {
    const key = `${keyBase}.${String(index)}`;
    switch (token.kind) {
      case "plain":
        return token.text;
      case "link":
        return (
          <a
            key={key}
            className={styles.bodyLink}
            href={token.href}
            target="_blank"
            rel="noreferrer noopener"
          >
            {token.href}
          </a>
        );
      case "mention":
        return (
          <span key={key} className={styles.bodyMention}>
            @{token.name}
          </span>
        );
      case "channel":
        return (
          <span key={key} className={styles.bodyChannel}>
            #{token.name}
          </span>
        );
    }
  });
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
