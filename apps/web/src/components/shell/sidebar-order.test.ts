import { describe, expect, it } from "vitest";
import {
  orderByActivity,
  orderRows,
  orderSocial,
  socialNameSet,
} from "./sidebar-order.js";

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

  // The Direct-messages section calls it this way since #515: alphabetical
  // only, with recency supplied by orderByActivity instead of the bump pref.
  it("sorts alphabetically with no stamp accessor at all", () => {
    expect(
      orderRows([row("Cider", 500), row("Alder"), row("Birch", 100)], (r) =>
        String(r.name),
      ).map((r) => r.name),
    ).toEqual(["Alder", "Birch", "Cider"]);
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

// #515: recent DM activity is the people sections' base sort. These cases are
// the #462/#463 unread-float suite ported onto the new invariant — the float
// itself is gone, and what it used to prove ("the row with traffic is at the
// top") now has to hold whether or not that traffic is still unread.
describe("orderByActivity", () => {
  interface Person {
    name: string;
    /** Newest message id in this person's DM; 0 = no conversation. */
    activity?: number;
  }
  const order = (rows: Person[]) =>
    orderByActivity(rows, (r) => r.activity ?? 0).map((r) => r.name);

  it("puts rows with activity on top, most recent first", () => {
    expect(
      order([
        { name: "Dell" },
        { name: "Alder", activity: 100 },
        { name: "Birch" },
        { name: "Cider", activity: 200 },
      ]),
    ).toEqual(["Cider", "Alder", "Dell", "Birch"]);
  });

  it("keeps the incoming order (presence groups, alphabetical) as the tail", () => {
    expect(
      order([{ name: "Dell" }, { name: "Alder" }, { name: "Birch" }]),
    ).toEqual(["Dell", "Alder", "Birch"]);
  });

  // The invariant the retired float used to carry: an unread row is
  // recently-active by construction, so it lands above older read ones
  // without any unread-specific rule. (Unread is not an input here — that is
  // the point.)
  it("sorts a just-arrived (unread) row above read rows with older activity", () => {
    expect(
      order([
        { name: "ReadYesterday", activity: 40 },
        { name: "ReadThisMorning", activity: 90 },
        { name: "UnreadJustNow", activity: 120 },
      ]),
    ).toEqual(["UnreadJustNow", "ReadThisMorning", "ReadYesterday"]);
  });

  // The complaint that opened #515: reading used to drop the row back to its
  // alphabetical seat. Clearing unread does not touch the activity id, so the
  // order is identical before and after the read.
  it("does not move a row when its unread clears", () => {
    const rows = [
      { name: "Alder", activity: 0 },
      { name: "Cider", activity: 200 },
      { name: "Birch", activity: 0 },
    ];
    expect(order(rows)).toEqual(["Cider", "Alder", "Birch"]);
    // Same rows, same activity, badge cleared elsewhere in the store.
    expect(order(rows)).toEqual(["Cider", "Alder", "Birch"]);
  });

  it("is stable for rows with identical activity", () => {
    expect(
      order([
        { name: "Birch", activity: 7 },
        { name: "Alder", activity: 7 },
      ]),
    ).toEqual(["Birch", "Alder"]);
  });

  it("does not mutate the input", () => {
    const rows = [{ name: "B" }, { name: "A", activity: 1 }];
    order(rows);
    expect(rows.map((r) => r.name)).toEqual(["B", "A"]);
  });
});

describe("socialNameSet", () => {
  it("lowercases names so DMs dedupe against them case-insensitively (#290)", () => {
    const set = socialNameSet(["Nyx Firemane", "Ember"]);
    expect(set.has("nyx firemane")).toBe(true);
    expect(set.has("EMBER".toLowerCase())).toBe(true);
    expect(set.has("stranger")).toBe(false);
  });

  it("is empty for no friends or bookmarks", () => {
    expect(socialNameSet([]).size).toBe(0);
  });
});
