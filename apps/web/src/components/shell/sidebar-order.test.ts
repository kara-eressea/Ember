import { describe, expect, it } from "vitest";
import { orderRows } from "./sidebar-order.js";

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
