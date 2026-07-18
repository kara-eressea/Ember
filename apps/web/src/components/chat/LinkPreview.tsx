// LinkPreview panel (M8 step 13, COMPONENTS-link-preview-eicon.md §2,
// frames L·A–L·C): a floating media preview beside the log — the message
// stays visible, never a modal. Loading = shimmer box + "fetching…";
// failure renders NOTHING (absence is the design — no broken-image
// chrome). Dismiss: Esc / click-away; one preview at a time (store).

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { placeBeside } from "../profile/popover.js";
import { useLinkPreviewStore } from "../../stores/link-preview.js";
import styles from "./chat.module.css";

const PANEL_WIDTH = 340;

export function LinkPreview() {
  const preview = useLinkPreviewStore((s) => s.preview);
  const close = useLinkPreviewStore((s) => s.close);
  const panelRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number }>();
  // Which src has finished loading — a new target is implicitly "loading"
  // until its own onLoad fires, no reset effect needed.
  const [loadedSrc, setLoadedSrc] = useState<string>();
  const src = preview?.source.src;
  const state: "loading" | "ok" = loadedSrc === src ? "ok" : "loading";

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
    setPos(
      placeBeside(
        preview.anchor,
        { width: PANEL_WIDTH, height: element.offsetHeight },
        { width: window.innerWidth, height: window.innerHeight },
      ),
    );
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
            ? { top: pos.top, left: pos.left }
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
          {source.kind === "image" ? (
            <img
              className={styles.previewImg}
              style={state === "loading" ? { display: "none" } : undefined}
              src={source.src}
              alt={source.path}
              referrerPolicy="no-referrer"
              onLoad={() => {
                setLoadedSrc(source.src);
              }}
              onError={close}
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
              onError={close}
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
