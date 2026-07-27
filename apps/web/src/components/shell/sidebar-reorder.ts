// Manual drag-to-reorder of sidebar rows (#391), within a section only.
//
// The order lives in the synced user prefs (`sidebarOrder`, #412) so every
// attached browser agrees and a drop propagates over the `prefs.updated`
// fan-out; it is keyed by identityId because row ids (channel keys, character
// names) differ per identity. Each section holds an ordered list of row ids;
// a row absent from that list (a channel joined or a bookmark added after the
// last drag) sorts stably after the ordered ones, so new rows append at the
// end and the saved order is otherwise preserved.
//
// It used to live in localStorage under `emberchat.sidebarOrder`;
// `legacySidebarOrders` reads that key once so an existing order seeds the
// pref on first load (see Sidebar.tsx), after which prefs are the only truth.

import { SIDEBAR_SECTIONS, type SidebarSection } from "./sidebar-sections.js";

export type SidebarOrders = Partial<Record<SidebarSection, string[]>>;
/** identityId → per-section ordered row-id lists. */
export type SidebarOrderMap = Record<string, SidebarOrders>;

const LEGACY_STORAGE_KEY = "emberchat.sidebarOrder";

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

/**
 * Read the pre-#412 localStorage order map; anything malformed resolves to
 * empty. Only used to seed the synced pref once, then the key is dropped.
 */
export function legacySidebarOrders(): SidebarOrderMap {
  let parsed: unknown;
  try {
    const raw = localStorage.getItem(LEGACY_STORAGE_KEY);
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
        sections[section] = list;
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
 * Return a new map with one identity's section order replaced — pure; the
 * caller patches it onto the `sidebarOrder` pref (one write per drop).
 */
export function withSectionOrder(
  map: SidebarOrderMap,
  identityId: string,
  section: SidebarSection,
  ids: readonly string[],
): SidebarOrderMap {
  return {
    ...map,
    [identityId]: { ...map[identityId], [section]: [...ids] },
  };
}

/** Drop the pre-#412 localStorage key once its contents have been synced. */
export function clearLegacySidebarOrders(): void {
  try {
    localStorage.removeItem(LEGACY_STORAGE_KEY);
  } catch {
    // Storage may be unavailable (private mode) — nothing to clean up then.
  }
}
