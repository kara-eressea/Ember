import { describe, expect, it } from "vitest";

import { clientFrameSchema, PROTOCOL_VERSION } from "./index.js";

it("exposes the protocol version", () => {
  expect(PROTOCOL_VERSION).toBe(1);
});

const IDENTITY = "00000000-0000-7000-8000-000000000001";
const CONV = "00000000-0000-7000-8000-000000000002";

describe("clientFrameSchema", () => {
  it("accepts every M1 frame", () => {
    const frames = [
      { t: "hello", d: { token: "abc", protocolVersion: 1 } },
      {
        t: "hello",
        d: {
          token: "abc",
          protocolVersion: 1,
          resume: { [IDENTITY]: { convCursors: { [CONV]: 42 } } },
        },
      },
      { t: "sub", d: { identityId: IDENTITY } },
      { t: "unsub", d: { identityId: IDENTITY } },
      {
        t: "cmd",
        id: 1,
        d: { identityId: IDENTITY, action: "session.connect" },
      },
      { t: "cmd", d: { identityId: IDENTITY, action: "session.disconnect" } },
      {
        t: "cmd",
        id: 2,
        d: { identityId: IDENTITY, action: "channel.join", d: { key: "Dev" } },
      },
      {
        t: "cmd",
        id: 3,
        d: { identityId: IDENTITY, action: "channel.leave", d: { key: "Dev" } },
      },
      {
        t: "cmd",
        id: 4,
        d: {
          identityId: IDENTITY,
          action: "msg.send",
          d: { convId: CONV, bbcode: "[b]hi[/b]" },
        },
      },
      {
        t: "cmd",
        id: 5,
        d: { identityId: IDENTITY, action: "pm.open", d: { character: "Nyx" } },
      },
      { t: "ack", d: { identityId: IDENTITY, convId: CONV, messageId: 7 } },
      { t: "ping" },
    ];
    for (const frame of frames) {
      expect(
        clientFrameSchema.safeParse(frame).success,
        JSON.stringify(frame),
      ).toBe(true);
    }
  });

  it("rejects malformed frames", () => {
    const frames = [
      { t: "hello", d: { token: "", protocolVersion: 1 } },
      { t: "sub", d: { identityId: "not-a-uuid" } },
      { t: "cmd", d: { identityId: IDENTITY, action: "nuke.everything" } },
      {
        t: "cmd",
        d: {
          identityId: IDENTITY,
          action: "msg.send",
          d: { convId: CONV, bbcode: "" },
        },
      },
      { t: "ack", d: { identityId: IDENTITY, convId: CONV, messageId: 0 } },
      // Abuse bounds: pm.open names are capped and charset-checked.
      {
        t: "cmd",
        d: {
          identityId: IDENTITY,
          action: "pm.open",
          d: { character: "x".repeat(65) },
        },
      },
      {
        t: "cmd",
        d: {
          identityId: IDENTITY,
          action: "pm.open",
          d: { character: "Nyx<script>" },
        },
      },
      {
        t: "cmd",
        d: {
          identityId: IDENTITY,
          action: "channel.join",
          d: { key: "x".repeat(129) },
        },
      },
      { t: "yolo" },
      "not an object",
    ];
    for (const frame of frames) {
      expect(
        clientFrameSchema.safeParse(frame).success,
        JSON.stringify(frame),
      ).toBe(false);
    }
  });
});
