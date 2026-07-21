// findStatusMessage derives a character's STA message from whichever live
// session source knows it, case-insensitively, and returns undefined when none.

import { describe, expect, it } from "vitest";
import type { IdentitySession } from "../../stores/sessions.js";
import { findStatusMessage } from "./mini-status.js";

function session(overrides: Partial<IdentitySession>): IdentitySession {
  return {
    character: "Own Char",
    ownStatusmsg: "",
    channels: {},
    dms: {},
    ...overrides,
  } as IdentitySession;
}

describe("findStatusMessage", () => {
  it("returns undefined when there is no session", () => {
    expect(findStatusMessage(undefined, "Someone")).toBeUndefined();
  });

  it("reads the own STA message for the own character", () => {
    const s = session({ character: "Kara", ownStatusmsg: "brb" });
    expect(findStatusMessage(s, "kara")).toBe("brb");
  });

  it("returns undefined when own status is empty", () => {
    const s = session({ character: "Kara", ownStatusmsg: "" });
    expect(findStatusMessage(s, "Kara")).toBeUndefined();
  });

  it("finds a status message from a channel roster, case-insensitively", () => {
    const s = session({
      channels: {
        Frontpage: {
          members: [
            { character: "Alice", status: "online", statusmsg: "" },
            { character: "Bob", status: "away", statusmsg: "afk soon" },
          ],
        },
      } as unknown as IdentitySession["channels"],
    });
    expect(findStatusMessage(s, "bob")).toBe("afk soon");
    expect(findStatusMessage(s, "alice")).toBeUndefined();
  });

  it("falls back to a DM partner's status", () => {
    const s = session({
      dms: {
        c1: { partner: "Cara", statusmsg: "open for RP" },
      } as unknown as IdentitySession["dms"],
    });
    expect(findStatusMessage(s, "cara")).toBe("open for RP");
  });

  it("falls back to friends/bookmarks", () => {
    const s = session({
      social: {
        friends: [
          { name: "Dana", online: true, status: "online", statusmsg: "hi" },
        ],
        bookmarks: [],
        incoming: [],
        outgoing: [],
        fetchedAt: 0,
      },
    });
    expect(findStatusMessage(s, "dana")).toBe("hi");
  });

  it("returns undefined when the character is unknown", () => {
    expect(findStatusMessage(session({}), "Nobody")).toBeUndefined();
  });
});
