// BBCode → styled spans (COMPONENTS.md §7): the one render path for message
// bodies, system lines, channel descriptions, statusmsg — and, in M4 step 4,
// the composer preview, so what you preview is exactly what recipients see.
// Structure comes from the shared subset AST; plain text runs get the inline
// token pass (links, @name, #channel). [icon]/[eicon] render as name chips
// until step 3 brings inline images.

import { useMemo, type ReactNode } from "react";
import { parseBBCode, type BBNode } from "@emberchat/markdown-bbcode";
import { avatarUrl, eiconUrl } from "../../lib/avatar.js";
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
 * Display-mode/animation preferences arrive in M5.
 */
function InlineIcon({ tag, name }: { tag: "icon" | "eicon"; name: string }) {
  const src = tag === "eicon" ? eiconUrl(name) : avatarUrl(name);
  if (src === undefined) {
    return (
      <span className={styles.bodyCode} title={`[${tag}]`}>
        {name}
      </span>
    );
  }
  const img = (
    <img
      className={styles.bodyEicon}
      src={src}
      alt={name}
      title={name}
      width={60}
      height={60}
      loading="lazy"
    />
  );
  return tag === "icon" ? (
    <a
      href={`https://www.f-list.net/c/${encodeURIComponent(name)}`}
      target="_blank"
      rel="noreferrer noopener"
    >
      {img}
    </a>
  ) : (
    img
  );
}
