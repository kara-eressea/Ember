import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  configPath,
  decodeConfig,
  encodeConfig,
  readConfig,
  sameConfig,
  writeConfig,
  CONFIG_SCHEMA_VERSION,
  type DesktopConfig,
} from "./desktop-config.js";

const LOCAL: DesktopConfig = { mode: "local" };
const THIN: DesktopConfig = {
  mode: "thin-client",
  serverUrl: "https://chat.example.com",
};

function tempPath(): string {
  return configPath(mkdtempSync(join(tmpdir(), "eb-config-")));
}

describe("the config file", () => {
  it("lives beside the secrets file in the user data directory", () => {
    expect(configPath("/data/EmberChat")).toBe("/data/EmberChat/config.json");
  });

  it("round-trips both modes", () => {
    expect(decodeConfig(encodeConfig(LOCAL))).toEqual(LOCAL);
    expect(decodeConfig(encodeConfig(THIN))).toEqual(THIN);
  });

  it("is plain, readable JSON — it is not a secret", () => {
    // The point of the assertion: somebody who opens this file in an editor
    // should be able to see and change what it says.
    expect(JSON.parse(encodeConfig(THIN))).toEqual({
      version: CONFIG_SCHEMA_VERSION,
      mode: "thin-client",
      serverUrl: "https://chat.example.com",
    });
    expect(encodeConfig(LOCAL)).not.toContain("serverUrl");
  });

  it.each([
    ["empty", ""],
    ["not JSON", "{ mode: local"],
    ["truncated", '{"version": 1, "mo'],
    ["not an object", '"local"'],
    ["null", "null"],
    ["a version this build does not know", '{"version": 2, "mode": "local"}'],
    ["missing its version", '{"mode": "local"}'],
    ["a mode this build does not know", '{"version": 1, "mode": "hosted"}'],
    ["thin-client with no URL", '{"version": 1, "mode": "thin-client"}'],
    [
      "thin-client with a URL that is not one",
      '{"version": 1, "mode": "thin-client", "serverUrl": "file:///etc/passwd"}',
    ],
    [
      "thin-client with an unencrypted remote URL",
      '{"version": 1, "mode": "thin-client", "serverUrl": "http://chat.example.com"}',
    ],
  ])("reads as absent when it is %s", (_label, contents) => {
    // Absent means the chooser comes back, which is the whole recovery story:
    // nothing is deleted, and re-picking the same mode lands on the install
    // that was already there.
    expect(decodeConfig(contents)).toBeUndefined();
  });

  it("normalizes a hand-edited URL rather than trusting it", () => {
    expect(
      decodeConfig(
        '{"version": 1, "mode": "thin-client", "serverUrl": "chat.example.com/"}',
      ),
    ).toEqual(THIN);
  });

  it("survives a write/read round trip on disk", () => {
    const path = tempPath();
    writeConfig(path, THIN);
    expect(readConfig(path)).toEqual(THIN);
    writeConfig(path, LOCAL);
    expect(readConfig(path)).toEqual(LOCAL);
    expect(readFileSync(path, "utf8").endsWith("\n")).toBe(true);
  });

  it("reads a missing file as absent — that is what a first run looks like", () => {
    expect(readConfig(tempPath())).toBeUndefined();
  });

  it("reads a corrupt file as absent, and writes over it cleanly", () => {
    const path = tempPath();
    writeFileSync(path, "}{ this is not a config", "utf8");
    expect(readConfig(path)).toBeUndefined();
    writeConfig(path, LOCAL);
    expect(readConfig(path)).toEqual(LOCAL);
  });
});

describe("sameConfig", () => {
  it("tells a real mode change from re-picking what is already running", () => {
    expect(sameConfig(LOCAL, { mode: "local" })).toBe(true);
    expect(sameConfig(LOCAL, THIN)).toBe(false);
    expect(sameConfig(THIN, { ...THIN })).toBe(true);
    expect(
      sameConfig(THIN, {
        mode: "thin-client",
        serverUrl: "https://other.example",
      }),
    ).toBe(false);
  });

  it("treats an absent config as different from any choice", () => {
    expect(sameConfig(undefined, LOCAL)).toBe(false);
    expect(sameConfig(undefined, undefined)).toBe(true);
  });
});
