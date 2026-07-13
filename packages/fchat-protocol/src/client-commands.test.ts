import { describe, expect, it } from "vitest";
import {
  isKnownClientCommand,
  parseClientCommand,
  serializeClientCommand,
  type ClientCommand,
} from "./client-commands.js";

describe("serializeClientCommand", () => {
  it("serializes IDN with ticket identification", () => {
    const command: ClientCommand = {
      cmd: "IDN",
      payload: {
        method: "ticket",
        account: "user@example.com",
        ticket: "fct_abc123",
        character: "Hexxy",
        cname: "EmberChat",
        cversion: "0.1.0",
      },
    };
    expect(serializeClientCommand(command)).toBe(
      'IDN {"method":"ticket","account":"user@example.com","ticket":"fct_abc123","character":"Hexxy","cname":"EmberChat","cversion":"0.1.0"}',
    );
  });

  it("serializes a bare PIN reply with no trailing space", () => {
    expect(serializeClientCommand({ cmd: "PIN" })).toBe("PIN");
  });

  it("serializes the documented MSG sample", () => {
    expect(
      serializeClientCommand({
        cmd: "MSG",
        payload: { channel: "Frontpage", message: "Right, evenin'" },
      }),
    ).toBe('MSG {"channel":"Frontpage","message":"Right, evenin\'"}');
  });
});

describe("parseClientCommand", () => {
  const COMMANDS: readonly ClientCommand[] = [
    { cmd: "CHA" },
    {
      cmd: "IDN",
      payload: {
        method: "ticket",
        account: "user@example.com",
        ticket: "fct_abc123",
        character: "Hexxy",
        cname: "EmberChat",
        cversion: "0.1.0",
      },
    },
    { cmd: "JCH", payload: { channel: "Frontpage" } },
    { cmd: "LCH", payload: { channel: "ADH-c7fc4c15c858dd76d860" } },
    { cmd: "MSG", payload: { channel: "Frontpage", message: "héllo 世界 🦊" } },
    { cmd: "ORS" },
    { cmd: "PIN" },
    { cmd: "PRI", payload: { recipient: "Hexxy", message: "Hi there." } },
    {
      cmd: "STA",
      payload: {
        status: "looking",
        statusmsg: "I'm always available to RP :)",
      },
    },
    { cmd: "TPN", payload: { character: "Leon Priest", status: "clear" } },
  ];

  it.each(COMMANDS.map((command) => [command.cmd, command]))(
    "round-trips %s through serialize + parse",
    (_cmd, command) => {
      expect(parseClientCommand(serializeClientCommand(command))).toEqual(
        command,
      );
    },
  );

  it("rejects a client STA with the server-only crown status", () => {
    const raw = 'STA {"status":"crown","statusmsg":""}';
    expect(parseClientCommand(raw)).toEqual({ cmd: "STA", raw });
  });

  it("returns { cmd, raw } for unknown and malformed input", () => {
    expect(parseClientCommand('ZZZ {"foo":1}')).toEqual({
      cmd: "ZZZ",
      raw: 'ZZZ {"foo":1}',
    });
    expect(parseClientCommand("PI")).toEqual({ cmd: "PI", raw: "PI" });
    const mismatched = parseClientCommand(
      'PRI {"character":"Hexxy","message":"hi"}',
    );
    expect(isKnownClientCommand(mismatched)).toBe(false);
  });
});
