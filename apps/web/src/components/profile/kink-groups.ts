// Grouped-kink display derivation (#277). F-List lets a custom kink act as a
// folder for standard catalog kinks (`custom.children` — an array of standard
// kink ids). #275 flattens those grouped kinks into `ProfileDto.kinks` for the
// matcher, and each flattened entry keeps its catalog `name`; the display side
// resolves the ids back to names off that same list so expanding a custom
// group lists its member kinks instead of showing nothing.

export interface GroupedKink {
  id: number;
  name: string;
}

/** id → display name, built from a profile's resolved standard kinks — the
 * catalog the Kinks tab already renders. Grouped children are present here
 * because #275 flattens them in server-side. Only id/name are read, so any
 * catalog-shaped list works. */
export function kinkNameCatalog(
  kinks: readonly { id: number; name: string }[],
): Map<number, string> {
  return new Map(kinks.map((kink) => [kink.id, kink.name]));
}

/** The standard kinks grouped under a custom kink, resolved to display rows in
 * declaration order. Ids absent from the catalog (e.g. a stale mapping list)
 * are dropped rather than shown as a bare number. */
export function groupedChildren(
  children: readonly number[],
  catalog: Map<number, string>,
): GroupedKink[] {
  const rows: GroupedKink[] = [];
  for (const id of children) {
    const name = catalog.get(id);
    if (name !== undefined) {
      rows.push({ id, name });
    }
  }
  return rows;
}
