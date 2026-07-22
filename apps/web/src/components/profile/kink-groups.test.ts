import { describe, expect, it } from "vitest";

import { groupedChildren, kinkNameCatalog } from "./kink-groups.js";

type Kink = { id: number; name: string; description: string; choice: string };

const kink = (id: number, name: string): Kink => ({
  id,
  name,
  description: "",
  choice: "yes",
});

describe("kinkNameCatalog", () => {
  it("maps kink ids to their display names", () => {
    const catalog = kinkNameCatalog([kink(1, "Kissing"), kink(2, "Biting")]);
    expect(catalog.get(1)).toBe("Kissing");
    expect(catalog.get(2)).toBe("Biting");
    expect(catalog.size).toBe(2);
  });

  it("is empty for a profile with no kinks", () => {
    expect(kinkNameCatalog([]).size).toBe(0);
  });
});

describe("groupedChildren", () => {
  const catalog = kinkNameCatalog([
    kink(10, "Rope"),
    kink(11, "Cuffs"),
    kink(12, "Blindfolds"),
  ]);

  it("resolves child ids to name rows in declaration order", () => {
    expect(groupedChildren([12, 10], catalog)).toEqual([
      { id: 12, name: "Blindfolds" },
      { id: 10, name: "Rope" },
    ]);
  });

  it("drops ids absent from the catalog rather than showing a bare number", () => {
    expect(groupedChildren([10, 999, 11], catalog)).toEqual([
      { id: 10, name: "Rope" },
      { id: 11, name: "Cuffs" },
    ]);
  });

  it("returns an empty list for a custom with no children", () => {
    expect(groupedChildren([], catalog)).toEqual([]);
  });

  it("resolves grouped children flattened into the profile kink list (#277)", () => {
    // The #275 fixture shape: the grouped standard kinks live in the profile's
    // flattened `kinks`, so the catalog built from that list resolves them.
    const profileKinks = [kink(10, "Rope"), kink(11, "Cuffs")];
    const derived = groupedChildren([10, 11], kinkNameCatalog(profileKinks));
    expect(derived.map((row) => row.name)).toEqual(["Rope", "Cuffs"]);
  });
});
