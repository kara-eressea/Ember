import { describe, expect, it } from "vitest";

import { groupMembers, nameSet, type SortInput } from "./member-sort.js";

function member(character: string) {
  return { character, gender: "None", status: "online", statusmsg: "" };
}

function run(names: string[], opts: Partial<Omit<SortInput, "members">> = {}) {
  return groupMembers({
    members: names.map(member),
    oplist: opts.oplist ?? [],
    friends: opts.friends ?? new Set(),
    bookmarks: opts.bookmarks ?? new Set(),
  });
}

describe("groupMembers", () => {
  it("orders owner, ops, friends, bookmarks, then the rest", () => {
    const groups = run(["Zed", "Ann", "Bex", "Cy", "Dot"], {
      oplist: ["Ann", "Bex"], // Ann owner, Bex op
      friends: nameSet([{ name: "Cy" }]),
      bookmarks: nameSet([{ name: "Dot" }]),
    });
    expect(groups.map((g) => g.key)).toEqual([
      "owner",
      "op",
      "friend",
      "bookmark",
      "member",
    ]);
    expect(groups.map((g) => g.members.map((m) => m.character))).toEqual([
      ["Ann"],
      ["Bex"],
      ["Cy"],
      ["Dot"],
      ["Zed"],
    ]);
  });

  it("sorts alphabetically (case-insensitive) within a group", () => {
    const [group] = run(["delta", "Bravo", "alpha", "Charlie"]);
    expect(group!.members.map((m) => m.character)).toEqual([
      "alpha",
      "Bravo",
      "Charlie",
      "delta",
    ]);
  });

  it("op precedence beats friend and bookmark tiers", () => {
    const groups = run(["Ann"], {
      oplist: ["", "Ann"], // unowned channel, Ann is an op
      friends: nameSet([{ name: "Ann" }]),
      bookmarks: nameSet([{ name: "Ann" }]),
    });
    expect(groups).toHaveLength(1);
    expect(groups[0]!.key).toBe("op");
  });

  it("friend precedence beats bookmark when a name is in both lists", () => {
    const groups = run(["Ann"], {
      friends: nameSet([{ name: "Ann" }]),
      bookmarks: nameSet([{ name: "Ann" }]),
    });
    expect(groups[0]!.key).toBe("friend");
  });

  it("matches friends/bookmarks case-insensitively", () => {
    const groups = run(["AnnaBelle"], {
      friends: nameSet([{ name: "annabelle" }]),
    });
    expect(groups[0]!.key).toBe("friend");
  });

  it("drops empty groups and carries the right role glyph", () => {
    const groups = run(["Ann", "Zed"], { oplist: ["Ann"] });
    expect(groups.map((g) => g.key)).toEqual(["owner", "member"]);
    expect(groups.find((g) => g.key === "owner")!.role).toBe("owner");
    expect(groups.find((g) => g.key === "member")!.role).toBeNull();
  });
});

describe("nameSet", () => {
  it("lower-cases and tolerates an absent list", () => {
    expect(nameSet([{ name: "Foo" }, { name: "BAR" }])).toEqual(
      new Set(["foo", "bar"]),
    );
    expect(nameSet(undefined).size).toBe(0);
  });
});
