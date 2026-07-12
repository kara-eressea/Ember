import { describe, expect, it } from "vitest";
import {
  isKnownServerCommand,
  parseServerCommand,
  serializeServerCommand,
} from "./server-commands.js";

// Sample frames from design/server-commands.md (trimmed where the doc
// abbreviates with "...", and with the doc's JSON typos fixed).
const DOC_SAMPLES: readonly string[] = [
  'CDS {"description": "[color=red]No actual roleplay in here.[/color] This is the channel for RP offers and announcements.", "channel": "Looking for RP"}',
  'CHA {"channels": [{"name":"Hermaphrodites","mode":"both","characters":144},{"name":"Avians","mode":"chat","characters":20}]}',
  'COL { "oplist": ["","Robert Grayson","Natsudra"], "channel": "Frontpage"}',
  'CON {"count": 254}',
  'ERR {"message": "You have already joined this channel.", "number": 28}',
  'FLN {"character":"Hexxy"}',
  'HLO {"message":"Welcome. Running F-Chat 0.8.6-Lua by Kira. Enjoy your stay."}',
  'ICH {"users": [{"identity": "Shadlor"}, {"identity": "Bunnie Patcher"}, {"identity": "Hexxy"}], "channel": "Frontpage", "mode": "chat"}',
  'IDN {"character": "Hexxy"}',
  'JCH {"character": {"identity": "Hexxy"}, "channel": "Frontpage", "title": "Frontpage"}',
  'LCH {"channel": "Frontpage", "character": "Hexxy"}',
  'LIS {"characters": [["Alexandrea", "Female", "online", ""], ["Fa Mulan", "Female", "busy", "Away, check out my new alt Aya Kinjou!"], ["Viol", "Cunt-boy", "looking", ""]]}',
  'MSG {"message": "Right, evenin\'", "channel": "Frontpage", "character": "Hexxy"}',
  'NLN {"status": "online", "gender": "Male", "identity": "Hexxy"}',
  'ORS {"channels": [{"name":"ADH-300f8f419e0c4814c6a8","characters":0,"title":"Ariel\'s Fun Club"},{"name":"ADH-d2afa269718e5ff3fae7","characters":6,"title":"Monster Girl Dungeon RPG"}]}',
  "PIN",
  'PRI {"character": "Hexxy", "message": "Hi there."}',
  'STA {"status":"looking","character":"Jippen Faddoul","statusmsg":"Just testing something"}',
  'SYS { "message":"Testytest has been added to the moderator list for derp","channel": "ADH-011aeb5bb591b1f4721a"}',
  'TPN {"character":"Leon Priest","status":"clear"}',
  'VAR {"value":4096,"variable":"chat_max"}',
  'VAR {"value":0.5,"variable":"msg_flood"}',
  'VAR {"value":["frontpage"],"variable":"icon_blacklist"}',
  'VAR {"value":"35868","variable":"permissions"}',
];

describe("parseServerCommand", () => {
  it.each(DOC_SAMPLES.map((raw) => [raw.slice(0, 3), raw]))(
    "parses and round-trips the documented %s sample",
    (_cmd, raw) => {
      const command = parseServerCommand(raw);
      expect(isKnownServerCommand(command)).toBe(true);
      // Round-trip: re-serialize the typed command and parse it again.
      if (!isKnownServerCommand(command)) {
        throw new Error(`sample did not parse: ${raw}`);
      }
      const rewired = serializeServerCommand(command);
      expect(parseServerCommand(rewired)).toEqual(command);
    },
  );

  it("parses typed payload fields", () => {
    const command = parseServerCommand(
      'MSG {"message": "Right, evenin\'", "channel": "Frontpage", "character": "Hexxy"}',
    );
    expect(command).toEqual({
      cmd: "MSG",
      payload: {
        character: "Hexxy",
        message: "Right, evenin'",
        channel: "Frontpage",
      },
    });
  });

  it("parses a bare PIN", () => {
    expect(parseServerCommand("PIN")).toEqual({ cmd: "PIN" });
  });

  it("parses LIS character tuples", () => {
    const command = parseServerCommand(
      'LIS {"characters": [["Alexandrea", "Female", "online", ""], ["Fa Mulan", "Female", "busy", "Away!"]]}',
    );
    expect(command).toEqual({
      cmd: "LIS",
      payload: {
        characters: [
          ["Alexandrea", "Female", "online", ""],
          ["Fa Mulan", "Female", "busy", "Away!"],
        ],
      },
    });
  });

  it("defaults a missing STA statusmsg to the empty string", () => {
    expect(
      parseServerCommand('STA {"status":"online","character":"Hexxy"}'),
    ).toEqual({
      cmd: "STA",
      payload: { status: "online", character: "Hexxy", statusmsg: "" },
    });
  });

  it("preserves UTF-8 message content", () => {
    const command = parseServerCommand(
      'PRI {"character":"Ré","message":"héllo 世界 🦊"}',
    );
    expect(command).toEqual({
      cmd: "PRI",
      payload: { character: "Ré", message: "héllo 世界 🦊" },
    });
  });

  it("returns { cmd, raw } for unknown commands", () => {
    const raw = 'ZZZ {"foo": true}';
    const command = parseServerCommand(raw);
    expect(command).toEqual({ cmd: "ZZZ", raw });
    expect(isKnownServerCommand(command)).toBe(false);
  });

  it("returns { cmd, raw } for a known command with a mismatched payload", () => {
    const raw = 'MSG {"channel": "Frontpage"}';
    const command = parseServerCommand(raw);
    expect(command).toEqual({ cmd: "MSG", raw });
    expect(isKnownServerCommand(command)).toBe(false);
  });

  it("returns { cmd, raw } for malformed frames instead of throwing", () => {
    expect(parseServerCommand("")).toEqual({ cmd: "", raw: "" });
    expect(parseServerCommand("PI")).toEqual({ cmd: "PI", raw: "PI" });
    expect(parseServerCommand("MSG not json")).toEqual({
      cmd: "MSG",
      raw: "MSG not json",
    });
    expect(parseServerCommand('msg {"channel":"a"}')).toEqual({
      cmd: "msg",
      raw: 'msg {"channel":"a"}',
    });
  });
});
