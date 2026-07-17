// Profile-dialect BBCode body (COMPONENTS-profile-viewer.md §10): native
// EmberChat treatment, not an f-list.net reskin. Structure comes from the
// shared AST parsed under dialect "profile"; inline nodes reuse the chat
// renderer so text renders identically everywhere. Unknown tags already
// degraded to plain text in the parser — nothing here can throw on input.

import { useMemo, useState, type ReactNode } from "react";
import { parseBBCode, type BBNode } from "@emberchat/markdown-bbcode";
import { useProfileStore } from "../../stores/profile.js";
import chatStyles from "../chat/chat.module.css";
import { renderNodes, type ExtraNodeRenderer } from "../chat/RichText.js";
import styles from "./profile.module.css";

const ALIGN_CLASS: Record<string, string> = {
  left: styles.bbAlignLeft!,
  center: styles.bbAlignCenter!,
  right: styles.bbAlignRight!,
  justify: styles.bbAlignJustify!,
};

export function ProfileBBCode({ bbcode }: { bbcode: string }) {
  const nodes = useMemo(() => parseBBCode(bbcode, "profile"), [bbcode]);
  return <div className={styles.bbBody}>{renderNodes(nodes, "p", extra)}</div>;
}

const extra: ExtraNodeRenderer = (node, key) => {
  // [user] inside the viewer navigates the viewer itself — the mini card
  // popover layers below the modal (§13), so it would open hidden.
  if (node.type === "name" && node.tag === "user") {
    return (
      <button
        key={key}
        type="button"
        className={`${chatStyles.nameButton ?? ""} ${chatStyles.bodyMention}`}
        onClick={() => {
          useProfileStore.getState().open(node.name);
        }}
      >
        {node.name}
      </button>
    );
  }
  if (node.type === "hr") {
    return <hr key={key} className={styles.bbHr} />;
  }
  if (node.type === "collapse") {
    return <Collapse key={key} title={node.title} nodes={node.children} />;
  }
  if (node.type !== "block") {
    return undefined;
  }
  switch (node.tag) {
    case "heading":
      return (
        <span key={key} className={styles.bbHeading}>
          {renderNodes(node.children, key, extra)}
        </span>
      );
    case "big":
      return (
        <span key={key} className={styles.bbBig}>
          {renderNodes(node.children, key, extra)}
        </span>
      );
    case "small":
      return (
        <span key={key} className={styles.bbSmall}>
          {renderNodes(node.children, key, extra)}
        </span>
      );
    case "quote":
      return (
        <span key={key} className={styles.bbQuote}>
          {renderNodes(node.children, key, extra)}
        </span>
      );
    case "indent":
      return (
        <span key={key} className={styles.bbIndent}>
          {renderNodes(node.children, key, extra)}
        </span>
      );
    default:
      return (
        <span key={key} className={ALIGN_CLASS[node.tag] ?? ""}>
          {renderNodes(node.children, key, extra)}
        </span>
      );
  }
};

function Collapse({
  title,
  nodes,
}: {
  title: string;
  nodes: readonly BBNode[];
}): ReactNode {
  const [open, setOpen] = useState(false);
  return (
    <span className={styles.bbCollapse}>
      <button
        type="button"
        className={styles.bbCollapseHead}
        aria-expanded={open}
        onClick={() => {
          setOpen((value) => !value);
        }}
      >
        <span
          className={`${styles.bbCollapseChevron} ${
            open ? styles.bbCollapseChevronOpen : ""
          }`}
          aria-hidden
        >
          ▶
        </span>
        {title || "Show more"}
        <span className={styles.bbCollapseTag}>collapse</span>
      </button>
      {open && (
        <span className={styles.bbCollapseBody}>
          {renderNodes(nodes, "c", extra)}
        </span>
      )}
    </span>
  );
}
