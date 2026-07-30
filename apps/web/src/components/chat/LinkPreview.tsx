// LinkPreview panel (M8 step 13, COMPONENTS-link-preview-eicon.md §2,
// frames L·A–L·C): a floating media preview beside the log — the message
// stays visible, never a modal. Loading = shimmer box + "fetching…";
// failure (404 / dead link / transient network error) keeps the frame and
// shows a quiet "content not found" state with the raw URL still clickable,
// so it never flashes away (#193). Dismiss: Esc / click-away; one preview
// at a time (store).

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { placeBeside, POPOVER_MARGIN } from "../profile/popover.js";
import { useLinkPreviewStore } from "../../stores/link-preview.js";
import styles from "./chat.module.css";

const PANEL_WIDTH = 340;

export function LinkPreview() {
  const preview = useLinkPreviewStore((s) => s.preview);
  const close = useLinkPreviewStore((s) => s.close);
  const panelRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{
    top: number;
    left: number;
    maxHeight: number;
  }>();
  // Which src has finished loading / failed — a new target is implicitly
  // "loading" until its own onLoad or onError fires, no reset effect needed.
  const [loadedSrc, setLoadedSrc] = useState<string>();
  const [failedSrc, setFailedSrc] = useState<string>();
  const src = preview?.source.src;
  const state: "loading" | "ok" | "error" =
    failedSrc === src ? "error" : loadedSrc === src ? "ok" : "loading";

  useEffect(() => {
    if (!preview) {
      return;
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.stopPropagation();
        close();
      }
    }
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
    };
  }, [preview, close]);

  useLayoutEffect(() => {
    const element = panelRef.current;
    if (!element || !preview) {
      return;
    }
    // Clamp the panel to the viewport (#385): a tall preview near the bottom
    // edge would otherwise be pushed off-screen. Cap the height we hand the
    // placement math (so `top` clamps against the *capped* box) and cap the
    // panel itself, letting the media area scroll inside it.
    const maxHeight = window.innerHeight - 2 * POPOVER_MARGIN;
    const height = Math.min(element.offsetHeight, maxHeight);
    setPos({
      ...placeBeside(
        preview.anchor,
        { width: PANEL_WIDTH, height },
        { width: window.innerWidth, height: window.innerHeight },
      ),
      maxHeight,
    });
  }, [preview, state]);

  if (!preview) {
    return null;
  }
  const { source } = preview;
  return (
    <>
      {preview.mode === "click" && (
        <div
          className={styles.previewOverlay}
          onClick={close}
          onContextMenu={(event) => {
            // Same convention as the mini-card overlay: a right-click
            // dismisses instead of silently eating the interaction.
            event.preventDefault();
            close();
          }}
        />
      )}
      <div
        ref={panelRef}
        className={styles.linkPreview}
        role="dialog"
        aria-label={`Preview: ${source.path}`}
        style={
          pos
            ? { top: pos.top, left: pos.left, maxHeight: pos.maxHeight }
            : {
                top: preview.anchor.top,
                left: preview.anchor.right + 6,
                visibility: "hidden",
              }
        }
      >
        <div className={styles.previewMedia}>
          {state === "loading" && (
            <div className={styles.previewSkeleton} aria-hidden />
          )}
          {/* A dead link (404) or a transient network error keeps the frame
              — we render a quiet "not found" state with the raw URL still
              reachable, rather than flashing the panel away (#193). */}
          {state === "error" ? (
            <div className={styles.previewError} role="alert">
              <span className={styles.previewErrorGlyph} aria-hidden>
                ⚠
              </span>
              <p className={styles.previewErrorText}>
                This content could not be loaded — it may have been moved or
                removed.
              </p>
              <a
                className={styles.previewErrorLink}
                href={preview.href}
                target="_blank"
                rel="noreferrer noopener"
              >
                Open link in a new tab ↗
              </a>
            </div>
          ) : source.kind === "image" ? (
            <img
              className={styles.previewImg}
              style={state === "loading" ? { display: "none" } : undefined}
              src={source.src}
              alt={source.path}
              referrerPolicy="no-referrer"
              onLoad={() => {
                setLoadedSrc(source.src);
              }}
              onError={() => {
                setFailedSrc(source.src);
              }}
            />
          ) : (
            <video
              className={styles.previewImg}
              style={state === "loading" ? { display: "none" } : undefined}
              src={source.src}
              autoPlay
              muted
              loop
              playsInline
              onLoadedData={() => {
                setLoadedSrc(source.src);
              }}
              onError={() => {
                setFailedSrc(source.src);
              }}
            />
          )}
        </div>
        <div className={styles.previewFoot}>
          <span aria-hidden>▣</span>
          <span className={styles.previewPath}>
            {state === "loading" ? "fetching…" : source.path}
          </span>
          <button
            type="button"
            className={styles.previewClose}
            aria-label="Close preview"
            onClick={close}
          >
            ✕
          </button>
        </div>
      </div>
    </>
  );
}
