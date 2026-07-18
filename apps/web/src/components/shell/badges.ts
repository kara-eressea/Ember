// Shared presence-dot classes + badge clamp for the rail and sidebar —
// previously duplicated in both (M3 audit backlog).

import type { DotKind } from "../../lib/presence.js";
import styles from "./shell.module.css";

export const DOT_CLASS: Record<DotKind, string> = {
  ok: styles.dotOk!,
  warn: styles.dotWarn!,
  faint: styles.dotFaint!,
};

/** Badge counts render at most two digits: 100 → "99+". */
export function clampBadge(count: number): string {
  return count > 99 ? "99+" : String(count);
}
