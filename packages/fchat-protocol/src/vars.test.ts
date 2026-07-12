import { describe, expect, it } from "vitest";
import {
  parseServerCommand,
  type ServerCommandPayload,
} from "./server-commands.js";
import { applyVar, DEFAULT_SERVER_VARS } from "./vars.js";

function varPayload(raw: string): ServerCommandPayload<"VAR"> {
  const command = parseServerCommand(raw);
  if (!("payload" in command) || command.cmd !== "VAR") {
    throw new Error(`Not a VAR frame: ${raw}`);
  }
  return command.payload;
}

describe("applyVar", () => {
  it("applies the documented VAR sequence", () => {
    const samples = [
      'VAR {"value":4096,"variable":"chat_max"}',
      'VAR {"value":50000,"variable":"priv_max"}',
      'VAR {"value":50000,"variable":"lfrp_max"}',
      'VAR {"value":600,"variable":"lfrp_flood"}',
      'VAR {"value":0.5,"variable":"msg_flood"}',
      'VAR {"value":["frontpage"],"variable":"icon_blacklist"}',
      'VAR {"value":"35868","variable":"permissions"}',
    ];
    const vars = samples.reduce(
      (acc, sample) => applyVar(acc, varPayload(sample)),
      DEFAULT_SERVER_VARS,
    );
    expect(vars).toEqual({
      chat_max: 4096,
      priv_max: 50000,
      lfrp_max: 50000,
      lfrp_flood: 600,
      msg_flood: 0.5,
      permissions: 35868,
      icon_blacklist: ["frontpage"],
    });
  });

  it("coerces numeric values sent as strings", () => {
    const vars = applyVar(DEFAULT_SERVER_VARS, {
      variable: "chat_max",
      value: "8192",
    });
    expect(vars.chat_max).toBe(8192);
  });

  it("ignores unknown variables", () => {
    const vars = applyVar(DEFAULT_SERVER_VARS, {
      variable: "shiny_new_limit",
      value: 1,
    });
    expect(vars).toEqual(DEFAULT_SERVER_VARS);
  });

  it("ignores unusable values instead of corrupting state", () => {
    expect(
      applyVar(DEFAULT_SERVER_VARS, { variable: "chat_max", value: ["nope"] }),
    ).toEqual(DEFAULT_SERVER_VARS);
    expect(
      applyVar(DEFAULT_SERVER_VARS, {
        variable: "chat_max",
        value: "not a number",
      }),
    ).toEqual(DEFAULT_SERVER_VARS);
    expect(
      applyVar(DEFAULT_SERVER_VARS, { variable: "icon_blacklist", value: 3 }),
    ).toEqual(DEFAULT_SERVER_VARS);
  });
});
