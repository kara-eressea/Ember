// The composer formatting toolbar (#205): the top row of the MessageBox.
// Promoted actions in six clusters, `?` help pinned right, popovers for
// colour / timer / link / character actions, and the narrow-width priority
// collapse into a `⋯` overflow. All pure decisions (clusters, collapse
// order, caret reflection, labels) live in composer-toolbar.ts; this file
// is the React shell. Glyphs are inline SVG stroked in currentColor or
// UI-font letters — never system emoji.

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { placePopover, type PopoverPlacement } from "../profile/popover.js";
import type { CardAnchor } from "../../stores/profile.js";
import {
  ACTION_LABELS,
  caretFormats,
  clampDelay,
  collapsedActions,
  delayLabel,
  TIMER_PRESETS,
  TOOLBAR_CLUSTERS,
  type ToolbarActionId,
} from "./composer-toolbar.js";
import styles from "./chat.module.css";

/** Swatch order in the colour popover (spec §4) → wire colour names. */
const SWATCHES: readonly { name: string; label: string }[] = [
  { name: "red", label: "Red" },
  { name: "orange", label: "Orange" },
  { name: "yellow", label: "Yellow" },
  { name: "green", label: "Green" },
  { name: "cyan", label: "Cyan" },
  { name: "blue", label: "Blue" },
  { name: "purple", label: "Purple" },
  { name: "pink", label: "Pink" },
  { name: "brown", label: "Brown" },
  { name: "black", label: "Black" },
  { name: "gray", label: "Grey" },
  { name: "white", label: "White" },
];

type PopoverKind =
  "color" | "timer" | "link" | "charlink" | "charicon" | "overflow";

export interface ComposerToolbarProps {
  markdown: boolean;
  disabled: boolean;
  text: string;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  sendDelaySeconds: number;
  onSetDelay: (seconds: number) => void;
  onWrapFormat: (md: string | undefined, tag: string, param?: string) => void;
  onWrapSelection: (marker: string) => void;
  onReplaceSelection: (snippet: string) => void;
  onRemoveColor: () => void;
  onToggleEicon: (anchor: CardAnchor) => void;
  onOpenHelp: () => void;
}

function anchorOf(element: HTMLElement): CardAnchor {
  const rect = element.getBoundingClientRect();
  return {
    top: rect.top,
    left: rect.left,
    bottom: rect.bottom,
    right: rect.right,
  };
}

export function ComposerToolbar(props: ComposerToolbarProps) {
  const rowRef = useRef<HTMLDivElement>(null);
  const [rowWidth, setRowWidth] = useState<number>();
  const [popover, setPopover] = useState<{
    kind: PopoverKind;
    anchor: CardAnchor;
  }>();
  const [lastColor, setLastColor] = useState<string>();
  const [active, setActive] = useState<Set<ToolbarActionId>>(new Set());

  const armed = props.sendDelaySeconds > 0;
  const armedLabel = delayLabel(props.sendDelaySeconds);

  // Never wrap, never scroll (spec §8): watch the row's width and fold the
  // lower-priority actions into the ⋯ overflow. First ResizeObserver in
  // the app — idiomatic for an element-scoped width, no container queries
  // in use elsewhere.
  useEffect(() => {
    const row = rowRef.current;
    if (!row) {
      return;
    }
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) {
        setRowWidth(entry.contentRect.width);
      }
    });
    observer.observe(row);
    return () => {
      observer.disconnect();
    };
  }, []);

  // Toggle reflection (spec §3): on caret/selection change each style
  // button mirrors whether its format is active at the cursor.
  useEffect(() => {
    function refresh() {
      const el = props.inputRef.current;
      if (!el || document.activeElement !== el) {
        return;
      }
      setActive(caretFormats(el.value, el.selectionStart));
    }
    document.addEventListener("selectionchange", refresh);
    refresh();
    return () => {
      document.removeEventListener("selectionchange", refresh);
    };
  }, [props.inputRef, props.text]);

  const collapsed = new Set(
    rowWidth === undefined
      ? []
      : collapsedActions(rowWidth, armed ? armedLabel.length * 8 + 6 : 0),
  );

  function toggle(kind: PopoverKind, element: HTMLElement) {
    setPopover((open) =>
      open?.kind === kind ? undefined : { kind, anchor: anchorOf(element) },
    );
  }

  /** The selected text right now — prefills the link popover. */
  function selectedText(): string {
    const el = props.inputRef.current;
    return el ? props.text.slice(el.selectionStart, el.selectionEnd) : "";
  }

  function runAction(id: ToolbarActionId, element: HTMLElement) {
    switch (id) {
      case "bold":
        props.onWrapFormat("**", "b");
        break;
      case "italic":
        props.onWrapFormat("*", "i");
        break;
      case "underline":
        props.onWrapFormat(undefined, "u");
        break;
      case "strike":
        props.onWrapFormat("~~", "s");
        break;
      case "sup":
        props.onWrapFormat(undefined, "sup");
        break;
      case "sub":
        props.onWrapFormat(undefined, "sub");
        break;
      case "spoiler":
        props.onWrapSelection("||");
        break;
      case "code":
        props.onWrapSelection("`");
        break;
      case "noparse":
        props.onWrapFormat(undefined, "noparse");
        break;
      case "eicon":
        props.onToggleEicon(anchorOf(element));
        break;
      case "color":
      case "link":
      case "charlink":
      case "charicon":
        toggle(id, element);
        break;
      case "timer":
        toggle("timer", element);
        break;
    }
  }

  function button(id: ToolbarActionId): ReactNode {
    const isArmedTimer = id === "timer" && armed;
    const on =
      active.has(id) ||
      (popover?.kind === id && id !== "timer") ||
      (id === "timer" && popover?.kind === "timer");
    const className = `${styles.iconBtn} ${
      isArmedTimer
        ? (styles.iconBtnArmed ?? "")
        : on
          ? (styles.iconBtnOn ?? "")
          : ""
    }`;
    const title =
      id === "bold"
        ? "Bold (Ctrl+B)"
        : id === "italic"
          ? "Italic (Ctrl+I)"
          : id === "underline"
            ? "Underline (Ctrl+U)"
            : id === "timer" && armed
              ? `Send timer — sends after ${armedLabel}`
              : ACTION_LABELS[id];
    return (
      <button
        key={id}
        type="button"
        className={className}
        title={title}
        aria-label={ACTION_LABELS[id]}
        aria-pressed={id === "timer" ? armed : active.has(id)}
        disabled={props.disabled}
        onClick={(event) => {
          runAction(id, event.currentTarget);
        }}
      >
        {glyph(id, lastColor)}
        {isArmedTimer && (
          <span className={styles.timerLabel}>{armedLabel}</span>
        )}
      </button>
    );
  }

  const clusters = TOOLBAR_CLUSTERS.map((cluster) =>
    cluster.filter((id) => !collapsed.has(id)),
  ).filter((cluster) => cluster.length > 0);
  const overflowing = collapsed.size > 0;

  return (
    <div
      ref={rowRef}
      className={styles.toolbarRow}
      role="toolbar"
      aria-label="Formatting"
    >
      {clusters.map((cluster, index) => (
        <span key={cluster[0]} className={styles.toolbarCluster}>
          {index > 0 && <span className={styles.tbDivider} aria-hidden />}
          {cluster.map((id) => button(id))}
        </span>
      ))}
      <span className={styles.tbSpacer} />
      {overflowing ? (
        <button
          type="button"
          className={`${styles.iconBtn} ${popover?.kind === "overflow" ? (styles.iconBtnOn ?? "") : ""}`}
          title="More"
          aria-label="More formatting"
          disabled={props.disabled}
          onClick={(event) => {
            toggle("overflow", event.currentTarget);
          }}
        >
          ⋯
        </button>
      ) : (
        <button
          type="button"
          className={styles.iconBtn}
          title="Formatting help"
          aria-label="Formatting help"
          onClick={props.onOpenHelp}
        >
          ?
        </button>
      )}
      {popover && (
        <ToolbarPopover
          anchor={popover.anchor}
          onClose={() => {
            setPopover(undefined);
          }}
        >
          {popover.kind === "color" && (
            <ColorPopover
              selected={lastColor}
              onPick={(name) => {
                setLastColor(name);
                props.onWrapFormat(undefined, "color", name);
                setPopover(undefined);
              }}
              onRemove={() => {
                props.onRemoveColor();
                setPopover(undefined);
              }}
            />
          )}
          {popover.kind === "timer" && (
            <TimerPopover
              seconds={props.sendDelaySeconds}
              onPick={(seconds) => {
                props.onSetDelay(seconds);
                setPopover(undefined);
              }}
            />
          )}
          {popover.kind === "link" && (
            <LinkPopover
              initialText={selectedText()}
              onConfirm={(snippet) => {
                props.onReplaceSelection(snippet);
                setPopover(undefined);
              }}
              onCancel={() => {
                setPopover(undefined);
              }}
            />
          )}
          {(popover.kind === "charlink" || popover.kind === "charicon") && (
            <CharacterPopover
              kind={popover.kind}
              onConfirm={(snippet) => {
                props.onReplaceSelection(snippet);
                setPopover(undefined);
              }}
              onCancel={() => {
                setPopover(undefined);
              }}
            />
          )}
          {popover.kind === "overflow" && (
            <div className={styles.tbMenu}>
              {[...collapsed].map((id) => (
                <button
                  key={id}
                  type="button"
                  className={styles.tbMenuItem}
                  onClick={(event) => {
                    const anchor = popover.anchor;
                    setPopover(undefined);
                    if (
                      id === "color" ||
                      id === "link" ||
                      id === "charlink" ||
                      id === "charicon"
                    ) {
                      // Re-anchor the follow-up popover on the ⋯ slot.
                      setPopover({ kind: id, anchor });
                      return;
                    }
                    runAction(id, event.currentTarget);
                  }}
                >
                  {ACTION_LABELS[id]}
                </button>
              ))}
              <button
                type="button"
                className={styles.tbMenuItem}
                onClick={() => {
                  setPopover(undefined);
                  props.onOpenHelp();
                }}
              >
                Formatting help
              </button>
            </div>
          )}
        </ToolbarPopover>
      )}
    </div>
  );
}

/** The shared popover shell: overlay to close, measured + viewport-clamped
 * placement (profile popover primitive). */
function ToolbarPopover({
  anchor,
  onClose,
  children,
}: {
  anchor: CardAnchor;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState<PopoverPlacement>();
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) {
      return;
    }
    setPlacement(
      placePopover(
        anchor,
        { width: element.offsetWidth, height: element.offsetHeight },
        { width: window.innerWidth, height: window.innerHeight },
      ),
    );
  }, [anchor]);
  useEffect(() => {
    function onKey(event: globalThis.KeyboardEvent) {
      if (event.key === "Escape") {
        onClose();
      }
    }
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);
  return (
    <>
      <div className={styles.tbOverlay} onClick={onClose} />
      <div
        ref={ref}
        role="dialog"
        className={styles.tbPopover}
        style={
          placement
            ? { top: placement.top, left: placement.left }
            : { top: 0, left: 0, visibility: "hidden" }
        }
      >
        {children}
      </div>
    </>
  );
}

function ColorPopover({
  selected,
  onPick,
  onRemove,
}: {
  selected?: string;
  onPick: (name: string) => void;
  onRemove: () => void;
}) {
  return (
    <div>
      <div className={styles.tbPopHead}>Text colour</div>
      <div className={styles.swatchGrid}>
        {SWATCHES.map(({ name, label }) => (
          <button
            key={name}
            type="button"
            title={label}
            aria-label={label}
            className={`${styles.swatch} ${selected === name ? (styles.swatchOn ?? "") : ""}`}
            style={{ background: `var(--eb-bbc-${name})` }}
            onClick={() => {
              onPick(name);
            }}
          />
        ))}
      </div>
      <button type="button" className={styles.tbPopRow} onClick={onRemove}>
        ✕ Remove colour
      </button>
    </div>
  );
}

function TimerPopover({
  seconds,
  onPick,
}: {
  seconds: number;
  onPick: (seconds: number) => void;
}) {
  const preset = TIMER_PRESETS.some((p) => p.seconds === seconds);
  const [custom, setCustom] = useState(!preset);
  const [customValue, setCustomValue] = useState(preset ? "" : String(seconds));
  return (
    <div>
      <div className={styles.tbPopHead}>Send timer</div>
      <div className={styles.tbMenu} role="radiogroup" aria-label="Delay">
        {TIMER_PRESETS.map((option) => (
          <button
            key={option.seconds}
            type="button"
            role="radio"
            aria-checked={!custom && seconds === option.seconds}
            className={`${styles.tbMenuItem} ${!custom && seconds === option.seconds ? (styles.tbMenuItemOn ?? "") : ""}`}
            onClick={() => {
              onPick(option.seconds);
            }}
          >
            {option.label}
          </button>
        ))}
        <button
          type="button"
          role="radio"
          aria-checked={custom}
          className={`${styles.tbMenuItem} ${custom ? (styles.tbMenuItemOn ?? "") : ""}`}
          onClick={() => {
            setCustom(true);
          }}
        >
          Custom…
        </button>
        {custom && (
          <form
            className={styles.tbCustomRow}
            onSubmit={(event) => {
              event.preventDefault();
              onPick(clampDelay(Number(customValue)));
            }}
          >
            <input
              className={styles.tbInput}
              type="number"
              min={1}
              max={300}
              value={customValue}
              placeholder="seconds"
              aria-label="Custom delay in seconds"
              onChange={(event) => {
                setCustomValue(event.target.value);
              }}
            />
            <button type="submit" className={styles.tbBtnAccent}>
              Set
            </button>
          </form>
        )}
      </div>
      <div className={styles.tbNote}>
        Gives you time to edit before it sends.
      </div>
    </div>
  );
}

function LinkPopover({
  initialText,
  onConfirm,
  onCancel,
}: {
  initialText: string;
  onConfirm: (snippet: string) => void;
  onCancel: () => void;
}) {
  const [label, setLabel] = useState(initialText);
  const [href, setHref] = useState("");
  const ok = /^https?:\/\/\S+$/.test(href.trim());
  return (
    <form
      className={styles.tbForm}
      onSubmit={(event) => {
        event.preventDefault();
        if (!ok) {
          return;
        }
        const address = href.trim();
        const text = label.trim();
        onConfirm(
          text === ""
            ? `[url]${address}[/url]`
            : `[url=${address}]${text}[/url]`,
        );
      }}
    >
      <div className={styles.tbPopHead}>Add link</div>
      <input
        className={styles.tbInput}
        value={label}
        placeholder="Text"
        aria-label="Link text"
        onChange={(event) => {
          setLabel(event.target.value);
        }}
      />
      <input
        className={styles.tbInput}
        value={href}
        placeholder="Address (https://…)"
        aria-label="Link address"
        autoFocus
        onChange={(event) => {
          setHref(event.target.value);
        }}
      />
      <div className={styles.tbNote}>
        With no text, the address itself becomes the link.
      </div>
      <div className={styles.tbActions}>
        <button type="button" className={styles.tbBtn} onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className={styles.tbBtnAccent} disabled={!ok}>
          Add link
        </button>
      </div>
    </form>
  );
}

function CharacterPopover({
  kind,
  onConfirm,
  onCancel,
}: {
  kind: "charlink" | "charicon";
  onConfirm: (snippet: string) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState("");
  const ok = name.trim() !== "";
  return (
    <form
      className={styles.tbForm}
      onSubmit={(event) => {
        event.preventDefault();
        if (!ok) {
          return;
        }
        const tag = kind === "charlink" ? "user" : "icon";
        onConfirm(`[${tag}]${name.trim()}[/${tag}]`);
      }}
    >
      <div className={styles.tbPopHead}>
        {kind === "charlink" ? "Character profile link" : "Character icon"}
      </div>
      <input
        className={styles.tbInput}
        value={name}
        placeholder="Character name"
        aria-label="Character name"
        autoFocus
        onChange={(event) => {
          setName(event.target.value);
        }}
      />
      <div className={styles.tbNote}>
        {kind === "charlink"
          ? "Does not notify or ping them — F-Chat has no mentions."
          : "No notification is sent."}
      </div>
      <div className={styles.tbActions}>
        <button type="button" className={styles.tbBtn} onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className={styles.tbBtnAccent} disabled={!ok}>
          Insert
        </button>
      </div>
    </form>
  );
}

/* ── Glyphs — inline SVG (17px, 1.7 stroke, currentColor) or UI-font
 *    letters, per spec §2/§3. Never system emoji. ─────────────────────── */

function svg(children: ReactNode): ReactNode {
  return (
    <svg
      width="17"
      height="17"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {children}
    </svg>
  );
}

function glyph(id: ToolbarActionId, lastColor?: string): ReactNode {
  switch (id) {
    case "bold":
      return <span className={styles.glyphB}>B</span>;
    case "italic":
      return <span className={styles.glyphI}>I</span>;
    case "underline":
      return <span className={styles.glyphU}>U</span>;
    case "strike":
      return <span className={styles.glyphS}>S</span>;
    case "sup":
      return (
        <span className={styles.glyphScript}>
          x<sup>2</sup>
        </span>
      );
    case "sub":
      return (
        <span className={styles.glyphScript}>
          x<sub>2</sub>
        </span>
      );
    case "spoiler":
      // Eye with a slash.
      return svg(
        <>
          <path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6Z" />
          <circle cx="12" cy="12" r="2.6" />
          <path d="M4 20 20 4" />
        </>,
      );
    case "code":
      // </> chevrons.
      return svg(
        <>
          <path d="m8.5 7-5 5 5 5" />
          <path d="m15.5 7 5 5-5 5" />
        </>,
      );
    case "noparse":
      // Circle-slash.
      return svg(
        <>
          <circle cx="12" cy="12" r="8.5" />
          <path d="M6 18 18 6" />
        </>,
      );
    case "color":
      return (
        <span
          className={styles.glyphColor}
          style={
            lastColor === undefined
              ? undefined
              : { color: `var(--eb-bbc-${lastColor})` }
          }
        >
          A
          <span className={styles.glyphColorBar} aria-hidden />
        </span>
      );
    case "eicon":
      // Smiley.
      return svg(
        <>
          <circle cx="12" cy="12" r="8.5" />
          <path d="M8.5 14.5c1 1.2 2.2 1.8 3.5 1.8s2.5-.6 3.5-1.8" />
          <path d="M9.2 9.6h.01M14.8 9.6h.01" strokeWidth="2.4" />
        </>,
      );
    case "charicon":
      // Portrait in a rounded frame.
      return svg(
        <>
          <rect x="3.5" y="3.5" width="17" height="17" rx="4" />
          <circle cx="12" cy="10" r="3" />
          <path d="M6.5 19c1-3 3-4.4 5.5-4.4s4.5 1.4 5.5 4.4" />
        </>,
      );
    case "link":
      // Chain.
      return svg(
        <>
          <path d="M9.5 14.5 14.5 9.5" />
          <path d="M11 6.8 13 4.8a4 4 0 0 1 5.7 5.7l-2 2" />
          <path d="M13 17.2 11 19.2a4 4 0 0 1-5.7-5.7l2-2" />
        </>,
      );
    case "charlink":
      return <span className={styles.glyphAt}>@</span>;
    case "timer":
      // Clock.
      return svg(
        <>
          <circle cx="12" cy="13" r="7.5" />
          <path d="M12 9.5V13l2.5 2" />
          <path d="M9.5 3.5h5" />
        </>,
      );
  }
}
