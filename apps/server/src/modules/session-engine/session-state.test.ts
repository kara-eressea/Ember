import { describe, expect, it } from "vitest";
import { DEFAULT_SERVER_VARS } from "@emberchat/fchat-protocol";
import { SessionState } from "./session-state.js";

describe("SessionState", () => {
  it("captures identity, vars, and connected count from the handshake", () => {
    const state = new SessionState();
    state.apply({ cmd: "IDN", payload: { character: "Amber Vale" } });
    state.apply({
      cmd: "VAR",
      payload: { variable: "msg_flood", value: 1.5 },
    });
    state.apply({
      cmd: "VAR",
      payload: { variable: "permissions", value: "35868" },
    });
    state.apply({ cmd: "CON", payload: { count: 4 } });
    expect(state.ownCharacter).toBe("Amber Vale");
    expect(state.vars.msg_flood).toBe(1.5);
    expect(state.vars.permissions).toBe(35868);
    expect(state.vars.chat_max).toBe(DEFAULT_SERVER_VARS.chat_max);
    expect(state.connectedCount).toBe(4);
  });

  it("builds presence from LIS batches, NLN, STA, and FLN", () => {
    const state = new SessionState();
    state.apply({
      cmd: "LIS",
      payload: {
        characters: [
          ["Nyx Firemane", "Female", "online", ""],
          ["Tally Marsh", "Male", "looking", "Open for scenes!"],
        ],
      },
    });
    state.apply({
      cmd: "NLN",
      payload: { identity: "Birch Rowan", gender: "Male", status: "online" },
    });
    expect(state.characters.size).toBe(3);

    state.apply({
      cmd: "STA",
      payload: { status: "busy", character: "Birch Rowan", statusmsg: "brb" },
    });
    expect(state.characters.get("Birch Rowan")).toEqual({
      gender: "Male",
      status: "busy",
      statusmsg: "brb",
    });

    state.apply({ cmd: "FLN", payload: { character: "Tally Marsh" } });
    expect(state.characters.has("Tally Marsh")).toBe(false);
  });

  it("builds channel state from JCH/ICH/COL/CDS and prunes on LCH", () => {
    const state = new SessionState();
    state.apply({ cmd: "IDN", payload: { character: "Amber Vale" } });
    state.apply({
      cmd: "JCH",
      payload: {
        channel: "Frontpage",
        character: { identity: "Amber Vale" },
        title: "Frontpage",
      },
    });
    state.apply({
      cmd: "COL",
      payload: { channel: "Frontpage", oplist: ["", "Nyx Firemane"] },
    });
    state.apply({
      cmd: "ICH",
      payload: {
        users: [{ identity: "Amber Vale" }, { identity: "Nyx Firemane" }],
        channel: "Frontpage",
        mode: "chat",
      },
    });
    state.apply({
      cmd: "CDS",
      payload: { channel: "Frontpage", description: "Be nice." },
    });

    const channel = state.channels.get("Frontpage");
    expect(channel).toBeDefined();
    expect(channel?.mode).toBe("chat");
    expect(channel?.description).toBe("Be nice.");
    expect(channel?.oplist).toEqual(["", "Nyx Firemane"]);
    expect([...(channel?.members ?? [])].sort()).toEqual([
      "Amber Vale",
      "Nyx Firemane",
    ]);

    // Another member joins, then leaves.
    state.apply({
      cmd: "JCH",
      payload: {
        channel: "Frontpage",
        character: { identity: "Birch Rowan" },
        title: "Frontpage",
      },
    });
    expect(channel?.members.has("Birch Rowan")).toBe(true);
    state.apply({
      cmd: "LCH",
      payload: { channel: "Frontpage", character: "Birch Rowan" },
    });
    expect(channel?.members.has("Birch Rowan")).toBe(false);

    // Our own LCH removes the whole channel.
    state.apply({
      cmd: "LCH",
      payload: { channel: "Frontpage", character: "Amber Vale" },
    });
    expect(state.channels.has("Frontpage")).toBe(false);
  });

  it("treats FLN as a global LCH", () => {
    const state = new SessionState();
    state.apply({ cmd: "IDN", payload: { character: "Amber Vale" } });
    state.apply({
      cmd: "JCH",
      payload: {
        channel: "Frontpage",
        character: { identity: "Amber Vale" },
        title: "Frontpage",
      },
    });
    state.apply({
      cmd: "JCH",
      payload: {
        channel: "Frontpage",
        character: { identity: "Nyx Firemane" },
        title: "Frontpage",
      },
    });
    state.apply({ cmd: "FLN", payload: { character: "Nyx Firemane" } });
    expect(state.channels.get("Frontpage")?.members.has("Nyx Firemane")).toBe(
      false,
    );
  });

  it("ignores channel commands for channels we are not in", () => {
    const state = new SessionState();
    state.apply({
      cmd: "CDS",
      payload: { channel: "Elsewhere", description: "x" },
    });
    state.apply({
      cmd: "COL",
      payload: { channel: "Elsewhere", oplist: [] },
    });
    state.apply({
      cmd: "ICH",
      payload: { users: [], channel: "Elsewhere", mode: "ads" },
    });
    expect(state.channels.size).toBe(0);
  });

  it("resetVolatile clears everything but keeps captured vars", () => {
    const state = new SessionState();
    state.apply({ cmd: "IDN", payload: { character: "Amber Vale" } });
    state.apply({
      cmd: "VAR",
      payload: { variable: "chat_max", value: 8192 },
    });
    state.apply({
      cmd: "NLN",
      payload: { identity: "Birch Rowan", gender: "Male", status: "online" },
    });
    state.resetVolatile();
    expect(state.ownCharacter).toBeUndefined();
    expect(state.characters.size).toBe(0);
    expect(state.channels.size).toBe(0);
    // Vars stay: the next connection re-sends them anyway, and outbound
    // length checks between connects should use the last known values.
    expect(state.vars.chat_max).toBe(8192);
  });

  it("walks the IGN transitions: init replaces, add/delete adjust, reset clears", () => {
    const state = new SessionState();
    // Before init, an empty list means "not seeded yet" — the snapshot falls
    // back to the persisted mirror instead of reporting nobody ignored.
    expect(state.ignoresSeeded).toBe(false);
    state.apply({
      cmd: "IGN",
      payload: { action: "init", characters: ["Teal Deer", "Old Name"] },
    });
    expect(state.ignoresSeeded).toBe(true);
    expect(state.isIgnored("teal deer")).toBe(true); // case-insensitive
    expect(state.isIgnored("TEAL DEER")).toBe(true);

    // A later init is a full replacement (another client edited the list).
    state.apply({
      cmd: "IGN",
      payload: { action: "init", characters: ["Teal Deer"] },
    });
    expect(state.isIgnored("Old Name")).toBe(false);

    state.apply({
      cmd: "IGN",
      payload: { action: "add", character: "Nyx Firemane" },
    });
    expect(state.isIgnored("nyx firemane")).toBe(true);
    expect([...state.ignores.values()].sort()).toEqual([
      "Nyx Firemane",
      "Teal Deer",
    ]);

    // Delete matches case-insensitively; unknown actions are swallowed.
    state.apply({
      cmd: "IGN",
      payload: { action: "delete", character: "TEAL DEER" },
    });
    expect(state.isIgnored("Teal Deer")).toBe(false);
    state.apply({ cmd: "IGN", payload: { action: "wat" } });
    expect(state.isIgnored("Nyx Firemane")).toBe(true);

    // Volatile: IGN init re-seeds on every identify.
    state.resetVolatile();
    expect(state.isIgnored("Nyx Firemane")).toBe(false);
    expect(state.ignoresSeeded).toBe(false);
  });
});

describe("SessionState moderation folds (M6)", () => {
  function joined(): SessionState {
    const state = new SessionState();
    state.apply({ cmd: "IDN", payload: { character: "Amber Vale" } });
    state.apply({
      cmd: "JCH",
      payload: {
        channel: "ADH-1",
        character: { identity: "Amber Vale" },
        title: "Attic",
      },
    });
    state.apply({
      cmd: "JCH",
      payload: {
        channel: "ADH-1",
        character: { identity: "Birch Rowan" },
        title: "Attic",
      },
    });
    state.apply({
      cmd: "COL",
      payload: { channel: "ADH-1", oplist: ["Amber Vale"] },
    });
    return state;
  }

  it("folds COA/COR/CSO into the oplist, protecting the owner slot", () => {
    const state = joined();
    state.apply({
      cmd: "COA",
      payload: { character: "Birch Rowan", channel: "ADH-1" },
    });
    expect(state.channels.get("ADH-1")?.oplist).toEqual([
      "Amber Vale",
      "Birch Rowan",
    ]);
    // COR never strips index 0 — CSO moves ownership.
    state.apply({
      cmd: "COR",
      payload: { character: "Amber Vale", channel: "ADH-1" },
    });
    expect(state.channels.get("ADH-1")?.oplist).toEqual([
      "Amber Vale",
      "Birch Rowan",
    ]);
    state.apply({
      cmd: "CSO",
      payload: { character: "Birch Rowan", channel: "ADH-1" },
    });
    expect(state.channels.get("ADH-1")?.oplist).toEqual(["Birch Rowan"]);
    state.apply({
      cmd: "COR",
      payload: { character: "Birch Rowan", channel: "ADH-1" },
    });
    expect(state.channels.get("ADH-1")?.oplist).toEqual(["Birch Rowan"]);
  });

  it("treats CKU/CBU/CTU as leaves — own removal drops the channel", () => {
    const state = joined();
    state.apply({
      cmd: "CKU",
      payload: {
        operator: "Amber Vale",
        channel: "ADH-1",
        character: "Birch Rowan",
      },
    });
    expect(state.channels.get("ADH-1")?.members.has("Birch Rowan")).toBe(false);
    state.apply({
      cmd: "CBU",
      payload: {
        operator: "Nyx Firemane",
        channel: "ADH-1",
        character: "Amber Vale",
      },
    });
    expect(state.channels.has("ADH-1")).toBe(false);
  });

  it("captures chatops from ADL and exposes ownIsChatop", () => {
    const state = new SessionState();
    state.apply({ cmd: "IDN", payload: { character: "Amber Vale" } });
    state.apply({ cmd: "ADL", payload: { ops: ["Amber Vale", "Silver"] } });
    expect(state.ownIsChatop).toBe(true);
    state.resetVolatile();
    expect(state.ownIsChatop).toBe(false);
  });

  it("captures the FRL friends+bookmarks union (M6 step 7)", () => {
    const state = new SessionState();
    state.apply({
      cmd: "FRL",
      payload: { characters: ["Nyx Firemane", "Old Greywhisker"] },
    });
    expect([...state.frl]).toEqual(["Nyx Firemane", "Old Greywhisker"]);
    state.resetVolatile();
    expect(state.frl.size).toBe(0);
  });
});
