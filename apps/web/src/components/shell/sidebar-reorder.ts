// Manual drag-to-reorder of sidebar rows (#391), within a section only.
//
// Order is a per-identity, per-device concern — it keys off channel keys and
// character names that differ per identity, so it persists in localStorage
// keyed by identityId, next to the collapsed-section state (sidebar-sections
// .ts) rather than in the synced user prefs. Each section holds an ordered
// list of row ids; a row absent from that list (a channel joined or a
// bookmark added after the last drag) sorts stably after the ordered ones,
// so new rows append at the end and the saved order is otherwise preserved.

import { SIDEBAR_SECTIONS, type SidebarSection } from "./sidebar-sections.js";

export type SidebarOrders = Partial<Record<SidebarSection, string[]>>;
/** identityId → per-section ordered row-id lists. */
export type SidebarOrderMap = Record<string, SidebarOrders>;

const STORAGE_KEY = "emberchat.sidebarOrder";

/**
 * Reorder `rows` by the saved id list: ids present in `order` come first in
 * that order, then any rows not in the list keep their incoming order (which
 * the caller has already default-sorted). Stable and non-mutating.
 */
export function applyManualOrder<T>(
  rows: readonly T[],
  id: (row: T) => string,
  order: readonly string[] | undefined,
): T[] {
  if (!order || order.length === 0) {
    return [...rows];
  }
  const rank = new Map<string, number>();
  order.forEach((key, index) => rank.set(key, index));
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => {
      const ra = rank.get(id(a.row)) ?? Infinity;
      const rb = rank.get(id(b.row)) ?? Infinity;
      if (ra !== rb) {
        return ra - rb;
      }
      // Same rank bucket (both unranked) — keep the incoming default order.
      return a.index - b.index;
    })
    .map((entry) => entry.row);
}

/**
 * Compute the new id order after dropping `dragged` before/after `target`
 * within the current visual `ids` sequence. A drop onto itself, or with an
 * unknown target, returns the input unchanged.
 */
export function moveRow(
  ids: readonly string[],
  dragged: string,
  target: string,
  position: "before" | "after",
): string[] {
  if (dragged === target) {
    return [...ids];
  }
  const without = ids.filter((id) => id !== dragged);
  const targetIndex = without.indexOf(target);
  if (targetIndex === -1) {
    return [...ids];
  }
  const insertAt = position === "after" ? targetIndex + 1 : targetIndex;
  without.splice(insertAt, 0, dragged);
  return without;
}

/** Read the persisted order map; anything malformed resolves to empty. */
export function loadSidebarOrders(): SidebarOrderMap {
  let parsed: unknown;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) {
      return {};
    }
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null) {
    return {};
  }
  const map: SidebarOrderMap = {};
  for (const [identityId, value] of Object.entries(
    parsed as Record<string, unknown>,
  )) {
    if (typeof value !== "object" || value === null) {
      continue;
    }
    const sections: SidebarOrders = {};
    for (const section of SIDEBAR_SECTIONS) {
      const list = (value as Record<string, unknown>)[section];
      if (Array.isArray(list) && list.every((x) => typeof x === "string")) {
        sections[section] = list as string[];
      }
    }
    map[identityId] = sections;
  }
  return map;
}

/** The saved order for one identity + section (undefined when unset). */
export function sectionOrder(
  map: SidebarOrderMap,
  identityId: string,
  section: SidebarSection,
): string[] | undefined {
  return map[identityId]?.[section];
}

/**
 * Return a new map with one identity's section order replaced, and persist it.
 * Pure aside from the write — returns the next map so callers drive React
 * state from it.
 */
export function saveSectionOrder(
  map: SidebarOrderMap,
  identityId: string,
  section: SidebarSection,
  ids: readonly string[],
): SidebarOrderMap {
  const next: SidebarOrderMap = {
    ...map,
    [identityId]: { ...map[identityId], [section]: [...ids] },
  };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Storage may be unavailable (private mode) — the reorder still holds for
    // this tab's lifetime via the returned map.
  }
  return next;
}
