import { describe, expect, it } from "vitest";

import {
  clientFrameSchema,
  PROTOCOL_VERSION,
  putRatingSchema,
} from "./index.js";

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

  it("validates the M4 cmd payloads at their bounds", () => {
    const ok = [
      {
        t: "cmd",
        d: {
          identityId: IDENTITY,
          action: "prefs.set",
          d: { sendDelaySeconds: 300 },
        },
      },
      {
        t: "cmd",
        d: {
          identityId: IDENTITY,
          action: "typing.set",
          d: { character: "Nyx Firemane", status: "paused" },
        },
      },
    ];
    for (const frame of ok) {
      expect(
        clientFrameSchema.safeParse(frame).success,
        JSON.stringify(frame),
      ).toBe(true);
    }
    const bad = [
      {
        t: "cmd",
        d: {
          identityId: IDENTITY,
          action: "prefs.set",
          d: { sendDelaySeconds: 301 },
        },
      },
      {
        t: "cmd",
        d: {
          identityId: IDENTITY,
          action: "prefs.set",
          d: { sendDelaySeconds: -1 },
        },
      },
      {
        t: "cmd",
        d: {
          identityId: IDENTITY,
          action: "typing.set",
          d: { character: "Nyx Firemane", status: "busy" },
        },
      },
    ];
    for (const frame of bad) {
      expect(
        clientFrameSchema.safeParse(frame).success,
        JSON.stringify(frame),
      ).toBe(false);
    }
  });
});

describe("M11 campaign & rating schemas", () => {
  const ID = "11111111-1111-4111-8111-111111111111";
  const cmd = (action: string, d: unknown) =>
    clientFrameSchema.safeParse({
      t: "cmd",
      d: { id: 1, identityId: ID, action, d },
    });

  it("accepts campaign.start and demands at least one tag and channel", () => {
    expect(
      cmd("campaign.start", { tags: ["slowburn"], channels: ["frontpage"] })
        .success,
    ).toBe(true);
    expect(cmd("campaign.start", { tags: [], channels: ["x"] }).success).toBe(
      false,
    );
    expect(
      cmd("campaign.start", { tags: ["slowburn"], channels: [] }).success,
    ).toBe(false);
  });

  it("campaign.stop/renew take empty payloads; drop takes a key", () => {
    expect(cmd("campaign.stop", {}).success).toBe(true);
    expect(cmd("campaign.renew", {}).success).toBe(true);
    expect(cmd("campaign.drop", { key: "frontpage" }).success).toBe(true);
    expect(cmd("campaign.drop", {}).success).toBe(false);
  });

  it("putRatingSchema bounds the score to whole stars 1-5", () => {
    expect(putRatingSchema.safeParse({ score: 3 }).success).toBe(true);
    expect(
      putRatingSchema.safeParse({ score: 5, note: "great pacing" }).success,
    ).toBe(true);
    expect(putRatingSchema.safeParse({ score: 0 }).success).toBe(false);
    expect(putRatingSchema.safeParse({ score: 6 }).success).toBe(false);
    expect(putRatingSchema.safeParse({ score: 2.5 }).success).toBe(false);
  });
});
