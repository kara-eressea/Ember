import { describe, expect, it } from "vitest";
import { parseFrame, serializeFrame } from "./codec.js";

describe("parseFrame", () => {
  it("parses a command with a JSON payload", () => {
    const result = parseFrame(
      'ERR {"message": "You have already joined this channel.", "number": 28}',
    );
    expect(result).toEqual({
      ok: true,
      frame: {
        cmd: "ERR",
        payload: {
          message: "You have already joined this channel.",
          number: 28,
        },
      },
    });
  });

  it("parses a bare command", () => {
    expect(parseFrame("PIN")).toEqual({ ok: true, frame: { cmd: "PIN" } });
  });

  it("preserves UTF-8 payload content", () => {
    const result = parseFrame(
      'MSG {"message":"héllo 世界 🦊","channel":"Frontpage","character":"Ré"}',
    );
    expect(result).toEqual({
      ok: true,
      frame: {
        cmd: "MSG",
        payload: {
          message: "héllo 世界 🦊",
          channel: "Frontpage",
          character: "Ré",
        },
      },
    });
  });

  it("rejects input shorter than three characters", () => {
    expect(parseFrame("")).toEqual({ ok: false, reason: "too-short", raw: "" });
    expect(parseFrame("PI")).toEqual({
      ok: false,
      reason: "too-short",
      raw: "PI",
    });
  });

  it("rejects commands that are not three uppercase letters", () => {
    expect(parseFrame("pin")).toMatchObject({
      ok: false,
      reason: "bad-command",
    });
    expect(parseFrame('1AB {"x":1}')).toMatchObject({
      ok: false,
      reason: "bad-command",
    });
  });

  it("rejects a missing separator between command and payload", () => {
    expect(parseFrame('MSG{"channel":"a","message":"b"}')).toMatchObject({
      ok: false,
      reason: "missing-separator",
    });
  });

  it("rejects invalid JSON payloads", () => {
    expect(parseFrame("MSG not json")).toMatchObject({
      ok: false,
      reason: "bad-json",
    });
    expect(parseFrame('MSG {"unterminated')).toMatchObject({
      ok: false,
      reason: "bad-json",
    });
    // A bare command must not carry a trailing space.
    expect(parseFrame("PIN ")).toMatchObject({ ok: false, reason: "bad-json" });
  });
});

describe("serializeFrame", () => {
  it("serializes a command with a payload", () => {
    expect(
      serializeFrame({ cmd: "JCH", payload: { channel: "Frontpage" } }),
    ).toBe('JCH {"channel":"Frontpage"}');
  });

  it("serializes a bare command with no trailing space", () => {
    expect(serializeFrame({ cmd: "PIN" })).toBe("PIN");
  });

  it("round-trips through parseFrame", () => {
    const frame = {
      cmd: "MSG",
      payload: { channel: "Frontpage", message: "héllo 世界 🦊" },
    };
    expect(parseFrame(serializeFrame(frame))).toEqual({ ok: true, frame });
  });

  it("throws on an invalid command name", () => {
    expect(() => serializeFrame({ cmd: "PING" })).toThrow(TypeError);
    expect(() => serializeFrame({ cmd: "pin" })).toThrow(TypeError);
  });
});
