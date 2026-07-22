// Private-note save-state machine (COMPONENTS-dm-sidebar.md §3). Kept pure so
// the ✓ Saved / Saving… / ⚠ Not saved transitions are unit-tested without a
// DOM. The editor holds one NoteSaveState and folds events into it; a stale
// callback (a resolved PUT that a newer edit already superseded) is ignored by
// the component via a request token, not here.

export type NoteSaveState = "idle" | "saving" | "saved" | "error";

export type NoteSaveEvent =
  | "edit" // the body changed — a save is scheduled/in flight
  | "saved" // the write committed
  | "error" // the write failed
  | "reset"; // editor cleared/closed — no pending state to show

export function nextNoteSaveState(
  current: NoteSaveState,
  event: NoteSaveEvent,
): NoteSaveState {
  switch (event) {
    case "edit":
      return "saving";
    case "saved":
      // A late success only counts while we were still waiting for it — once
      // the user edits again (back to "saving"), an older resolve shouldn't
      // flash ✓. The component guards staleness by token, but keep the
      // machine honest: only "saving" advances to "saved".
      return current === "saving" ? "saved" : current;
    case "error":
      return current === "saving" ? "error" : current;
    case "reset":
      return "idle";
  }
}

/** Chip text for a save state, or null when nothing should show. */
export function noteSaveLabel(state: NoteSaveState): string | null {
  switch (state) {
    case "saving":
      return "Saving…";
    case "saved":
      return "✓ Saved";
    case "error":
      return "⚠ Not saved";
    case "idle":
      return null;
  }
}
