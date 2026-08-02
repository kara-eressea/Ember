import { describe, expect, it } from "vitest";
import type { SearchResultDto } from "../../lib/api.js";
import { mergePage, searchScope } from "./log-search.js";

function hit(id: number): SearchResultDto {
  return {
    id,
    convId: "c1",
    conversationKind: "channel",
    conversationTitle: "Potting Shed",
    senderCharacter: "Alder Fen",
    kind: "msg",
    bbcode: `hit ${String(id)}`,
    createdAt: new Date(1_700_000_000_000 + id).toISOString(),
  };
}

describe("searchScope", () => {
  it("scopes to the open conversation by default", () => {
    expect(searchScope(false, "c1")).toEqual({ convId: "c1" });
  });

  it("drops the scope for an Everywhere search", () => {
    expect(searchScope(true, "c1")).toEqual({});
  });

  it("has nothing to scope to with no conversation on screen", () => {
    expect(searchScope(false, undefined)).toEqual({});
  });
});

describe("mergePage", () => {
  it("replaces the list for a fresh search", () => {
    expect(mergePage([hit(1)], [hit(2)], undefined)).toEqual([hit(2)]);
  });

  it("appends the next cursor page", () => {
    expect(mergePage([hit(1)], [hit(2)], 99)).toEqual([hit(1), hit(2)]);
  });

  it("starts a page list from nothing when the first render is still empty", () => {
    expect(mergePage(undefined, [hit(2)], 99)).toEqual([hit(2)]);
  });
});
