import { describe, expect, it } from "vitest";
import {
  bumpUnread,
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

describe("bumpUnread", () => {
  interface Person {
    name: string;
    highlightedAt?: number;
    newestMessageId?: number;
  }
  const order = (rows: Person[]) =>
    bumpUnread(rows, (r) =>
      r.highlightedAt === undefined && r.newestMessageId === undefined
        ? undefined
        : {
            highlightedAt: r.highlightedAt ?? 0,
            newestMessageId: r.newestMessageId ?? 0,
          },
    ).map((r) => r.name);

  it("floats rows with activity to the top, most recent first", () => {
    expect(
      order([
        { name: "Dell" },
        { name: "Alder", highlightedAt: 100 },
        { name: "Birch" },
        { name: "Cider", highlightedAt: 200 },
      ]),
    ).toEqual(["Cider", "Alder", "Dell", "Birch"]);
  });

  it("keeps the incoming order below the bumped rows", () => {
    expect(
      order([{ name: "Dell" }, { name: "Alder" }, { name: "Birch" }]),
    ).toEqual(["Dell", "Alder", "Birch"]);
  });

  it("breaks highlight ties on the newest message id", () => {
    expect(
      order([
        { name: "Alder", newestMessageId: 5 },
        { name: "Birch", newestMessageId: 9 },
        { name: "Cider", highlightedAt: 1, newestMessageId: 2 },
      ]),
    ).toEqual(["Cider", "Birch", "Alder"]);
  });

  it("is stable for rows with identical activity", () => {
    expect(
      order([
        { name: "Birch", highlightedAt: 7 },
        { name: "Alder", highlightedAt: 7 },
      ]),
    ).toEqual(["Birch", "Alder"]);
  });

  it("does not mutate the input", () => {
    const rows = [{ name: "B" }, { name: "A", highlightedAt: 1 }];
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
