// Role derivation off the owner-first COL oplist — the gating primitive for
// every role-dependent surface (context-menu admin section, op tooling).

import { describe, expect, it } from "vitest";
import { modPowers, roleFor, roleTag } from "./member-roles.js";

describe("roleFor", () => {
  const oplist = ["Nyx Firemane", "Tally Marsh", "Old Greywhisker"];

  it("derives owner / op / member from the owner-first oplist", () => {
    expect(roleFor("Nyx Firemane", oplist)).toBe("owner");
    expect(roleFor("Tally Marsh", oplist)).toBe("op");
    expect(roleFor("Old Greywhisker", oplist)).toBe("op");
    expect(roleFor("Amber Vale", oplist)).toBe(null);
  });

  it("matches case-insensitively", () => {
    expect(roleFor("nyx firemane", oplist)).toBe("owner");
    expect(roleFor("TALLY MARSH", oplist)).toBe("op");
  });

  it('an unowned channel ("" owner slot) has ops but no owner', () => {
    const unowned = ["", "Nyx Firemane"];
    expect(roleFor("", unowned)).toBe(null);
    expect(roleFor("Nyx Firemane", unowned)).toBe("op");
  });

  it("an empty oplist makes everyone a member", () => {
    expect(roleFor("Nyx Firemane", [])).toBe(null);
  });
});

describe("roleTag", () => {
  it("labels the §10 header tag", () => {
    expect(roleTag("owner")).toBe("owner ~");
    expect(roleTag("op")).toBe("channel op @");
    expect(roleTag(null)).toBe("member");
  });
});

describe("modPowers", () => {
  it("gives plain members and self no powers", () => {
    expect(
      modPowers({
        viewer: null,
        viewerChatop: false,
        target: null,
        self: false,
      }),
    ).toEqual({
      remove: false,
      promote: false,
      demote: false,
      setOwner: false,
    });
    expect(
      modPowers({
        viewer: "owner",
        viewerChatop: false,
        target: "owner",
        self: true,
      }),
    ).toEqual({
      remove: false,
      promote: false,
      demote: false,
      setOwner: false,
    });
  });

  it("ops moderate members but not other ops; owners outrank", () => {
    expect(
      modPowers({
        viewer: "op",
        viewerChatop: false,
        target: null,
        self: false,
      }),
    ).toEqual({ remove: true, promote: true, demote: false, setOwner: false });
    expect(
      modPowers({
        viewer: "op",
        viewerChatop: false,
        target: "op",
        self: false,
      }),
    ).toEqual({ remove: false, promote: false, demote: true, setOwner: false });
    expect(
      modPowers({
        viewer: "owner",
        viewerChatop: false,
        target: "op",
        self: false,
      }),
    ).toEqual({ remove: true, promote: false, demote: true, setOwner: true });
  });

  it("chatops outrank everyone, even without a channel role", () => {
    expect(
      modPowers({
        viewer: null,
        viewerChatop: true,
        target: "op",
        self: false,
      }),
    ).toEqual({ remove: true, promote: false, demote: true, setOwner: true });
    expect(
      modPowers({
        viewer: null,
        viewerChatop: true,
        target: "owner",
        self: false,
      }),
    ).toEqual({ remove: true, promote: false, demote: false, setOwner: false });
  });
});
