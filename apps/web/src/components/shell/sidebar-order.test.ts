import { describe, expect, it } from "vitest";
import { openDmPartnerSet, orderRows, orderSocial } from "./sidebar-order.js";

interface Row {
  name: string;
  highlightedAt: number;
}

const row = (name: string, highlightedAt = 0): Row => ({
  name,
  highlightedAt,
});
const order = (rows: Row[], bump: boolean) =>
  orderRows(
    rows,
    (r) => r.name,
    (r) => r.highlightedAt,
    bump,
  ).map((r) => r.name);

describe("orderRows", () => {
  it("sorts alphabetically with the bump pref off, ignoring stamps", () => {
    const rows = [row("Cider", 500), row("Alder"), row("Birch", 100)];
    expect(order(rows, false)).toEqual(["Alder", "Birch", "Cider"]);
  });

  it("floats bumped rows to the top, most recent first", () => {
    const rows = [row("Alder"), row("Cider", 100), row("Birch", 200)];
    expect(order(rows, true)).toEqual(["Birch", "Cider", "Alder"]);
  });

  it("keeps un-bumped rows alphabetical below the bumped ones", () => {
    const rows = [row("Dell"), row("Alder"), row("Cider", 100), row("Birch")];
    expect(order(rows, true)).toEqual(["Cider", "Alder", "Birch", "Dell"]);
  });

  it("does not mutate the input", () => {
    const rows = [row("B"), row("A")];
    order(rows, true);
    expect(rows.map((r) => r.name)).toEqual(["B", "A"]);
  });
});

describe("orderSocial", () => {
  const social = (name: string, online: boolean) => ({ name, online });
  const order = (rows: { name: string; online: boolean }[]) =>
    orderSocial(
      rows,
      (r) => r.name,
      (r) => r.online,
    ).map((r) => r.name);

  it("puts online rows first, alphabetical within each group", () => {
    const rows = [
      social("Dell", false),
      social("Cider", true),
      social("Alder", false),
      social("Birch", true),
    ];
    expect(order(rows)).toEqual(["Birch", "Cider", "Alder", "Dell"]);
  });

  it("does not mutate the input", () => {
    const rows = [social("B", false), social("A", true)];
    order(rows);
    expect(rows.map((r) => r.name)).toEqual(["B", "A"]);
  });
});

describe("openDmPartnerSet", () => {
  it("lowercases partners so social rows dedupe case-insensitively (#227)", () => {
    const set = openDmPartnerSet(["Nyx Firemane", "Ember"]);
    expect(set.has("nyx firemane")).toBe(true);
    expect(set.has("EMBER".toLowerCase())).toBe(true);
    expect(set.has("stranger")).toBe(false);
  });

  it("is empty for no open DMs", () => {
    expect(openDmPartnerSet([]).size).toBe(0);
  });
});
