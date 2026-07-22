// Profile-dialect BBCode body (COMPONENTS-profile-viewer.md §10): native
// EmberChat treatment, not an f-list.net reskin. Structure comes from the
// shared AST parsed under dialect "profile"; inline nodes reuse the chat
// renderer so text renders identically everywhere. Unknown tags already
// degraded to plain text in the parser — nothing here can throw on input.
//
// Profile descriptions may embed inline images via [img]id[/img], where id
// keys into the character-data `inlines` map (issue #212). Those resolve to
// static.f-list.net URLs here, lazy-load, cap at the content-column width, and
// open the shared lightbox on click.

import { useMemo, useState, type ReactNode } from "react";
import {
  parseBBCode,
  validHref,
  type BBNode,
} from "@emberchat/markdown-bbcode";
import type { ProfileInline } from "@emberchat/protocol";
import { useProfileStore } from "../../stores/profile.js";
import chatStyles from "../chat/chat.module.css";
import {
  ProfileLinkProvider,
  renderNodes,
  type ExtraNodeRenderer,
} from "../chat/RichText.js";
import { Lightbox } from "./ImagesTab.js";
import styles from "./profile.module.css";

// Inside the viewer, an f-list.net/c/<name> link swaps the viewer rather
// than opening the mini card (which would layer below the modal) — mirrors
// the [user] handling in `extra` below.
const openProfileLink = (_element: Element, name: string): void => {
  useProfileStore.getState().open(name);
};

const ALIGN_CLASS: Record<string, string> = {
  left: styles.bbAlignLeft!,
  center: styles.bbAlignCenter!,
  right: styles.bbAlignRight!,
  justify: styles.bbAlignJustify!,
};

type OpenImage = (url: string, alt: string) => void;

/** Resolve an [img] node's `src` (an inline id or a direct URL) to a URL, or
 * undefined when it references nothing we can show. */
function resolveImgSrc(
  src: string,
  inlines: Readonly<Record<string, ProfileInline>>,
): string | undefined {
  const inline = inlines[src];
  if (inline) {
    return inline.url;
  }
  return validHref(src) ? src : undefined;
}

export function ProfileBBCode({
  bbcode,
  inlines = {},
}: {
  bbcode: string;
  inlines?: Readonly<Record<string, ProfileInline>>;
}) {
  const nodes = useMemo(() => parseBBCode(bbcode, "profile"), [bbcode]);
  // A single-slide lightbox: inline images each open on their own, so there's
  // nothing to navigate between (unlike the gallery grid).
  const [lightbox, setLightbox] = useState<{ url: string; alt: string }>();

  const extra = useMemo<ExtraNodeRenderer>(
    () => makeExtra(inlines, (url, alt) => setLightbox({ url, alt })),
    [inlines],
  );

  return (
    <ProfileLinkProvider value={openProfileLink}>
      <div className={styles.bbBody}>{renderNodes(nodes, "p", extra)}</div>
      {lightbox && (
        <Lightbox
          images={[{ url: lightbox.url, description: lightbox.alt }]}
          index={0}
          onNavigate={() => {
            // Single slide — navigation is a no-op.
          }}
          onClose={() => {
            setLightbox(undefined);
          }}
        />
      )}
    </ProfileLinkProvider>
  );
}

/** Build the profile-specific node renderer. Closes over the inlines map and
 * the lightbox opener so [img] resolves and [user] navigates the viewer. */
function makeExtra(
  inlines: Readonly<Record<string, ProfileInline>>,
  onOpen: OpenImage,
): ExtraNodeRenderer {
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
    if (node.type === "img") {
      return (
        <InlineImage
          key={key}
          src={resolveImgSrc(node.src, inlines)}
          alt={node.alt}
          onOpen={onOpen}
        />
      );
    }
    if (node.type === "hr") {
      return <hr key={key} className={styles.bbHr} />;
    }
    if (node.type === "collapse") {
      return (
        <Collapse
          key={key}
          title={node.title}
          nodes={node.children}
          extra={extra}
        />
      );
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
  return extra;
}

/** An inline profile image: lazy, capped to the content column, click to open
 * the lightbox. An unresolvable reference or a dead upstream image degrades to
 * a quiet placeholder rather than a broken-image glyph. */
function InlineImage({
  src,
  alt,
  onOpen,
}: {
  src: string | undefined;
  alt: string;
  onOpen: OpenImage;
}): ReactNode {
  const [broken, setBroken] = useState(false);
  if (src === undefined || broken) {
    return (
      <span className={styles.bbImgBroken} title={alt || "image"}>
        {alt || "image"}
      </span>
    );
  }
  return (
    <button
      type="button"
      className={styles.bbImgBtn}
      onClick={() => {
        onOpen(src, alt);
      }}
      aria-label={alt || "Open image"}
    >
      <img
        className={styles.bbImg}
        src={src}
        alt={alt}
        loading="lazy"
        onError={() => {
          setBroken(true);
        }}
      />
    </button>
  );
}

function Collapse({
  title,
  nodes,
  extra,
}: {
  title: string;
  nodes: readonly BBNode[];
  extra: ExtraNodeRenderer;
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
