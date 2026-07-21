// Collapsible sidebar sections (#168). Collapsed state is per-device UI
// ergonomics, not a synced preference — it persists in localStorage like
// the saved-search run stamps (search-logic.ts) and the theme boot cache.

export const SIDEBAR_SECTIONS = [
  "channels",
  "dms",
  "friends",
  "bookmarks",
] as const;
export type SidebarSection = (typeof SIDEBAR_SECTIONS)[number];

export type CollapsedSections = Partial<Record<SidebarSection, boolean>>;

const STORAGE_KEY = "emberchat.sidebarCollapsed";

/** Read the persisted collapsed map; garbage resolves to all-expanded. */
export function loadCollapsedSections(): CollapsedSections {
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
  const collapsed: CollapsedSections = {};
  for (const section of SIDEBAR_SECTIONS) {
    if ((parsed as Record<string, unknown>)[section] === true) {
      collapsed[section] = true;
    }
  }
  return collapsed;
}

/** Toggle one section and persist the result; returns the new map. */
export function toggleCollapsedSection(
  collapsed: CollapsedSections,
  section: SidebarSection,
): CollapsedSections {
  const next: CollapsedSections = { ...collapsed };
  if (next[section] === true) {
    delete next[section];
  } else {
    next[section] = true;
  }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Storage may be unavailable (private mode) — the toggle still works
    // for this tab's lifetime.
  }
  return next;
}
