// When-highlighted actions (M5, decisions.md §10): one bundled chime
// (synthesized in-repo — license-clean by construction) and a title flash.
// Fired by dispatch when a flagged message lands outside the active,
// focused view; both stop mattering the moment the user looks.

import chimeUrl from "../assets/chime.wav";

let audio: HTMLAudioElement | undefined;

/** Best-effort chime — autoplay policies may refuse before first gesture. */
export function playHighlightChime(): void {
  try {
    audio ??= new Audio(chimeUrl);
    audio.currentTime = 0;
    void audio.play().catch(() => undefined);
  } catch {
    // No audio surface (or blocked) — a chime is never worth an error.
  }
}

let flashTimer: ReturnType<typeof setInterval> | undefined;
let baseTitle: string | undefined;

/**
 * Alternate the tab title with an [@] marker until the window regains
 * focus. Repeated mentions while flashing are one flash — the point is
 * "something happened here", not a counter.
 */
export function flashTitle(): void {
  if (flashTimer !== undefined || document.hasFocus()) {
    return;
  }
  baseTitle = document.title;
  let marked = false;
  flashTimer = setInterval(() => {
    marked = !marked;
    document.title = marked ? `[@] ${baseTitle ?? ""}` : (baseTitle ?? "");
  }, 1000);
  window.addEventListener("focus", stopTitleFlash);
}

export function stopTitleFlash(): void {
  if (flashTimer === undefined) {
    return;
  }
  clearInterval(flashTimer);
  flashTimer = undefined;
  window.removeEventListener("focus", stopTitleFlash);
  if (baseTitle !== undefined) {
    document.title = baseTitle;
    baseTitle = undefined;
  }
}
