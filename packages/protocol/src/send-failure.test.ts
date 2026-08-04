// The failed-DM wire additions (#491): the `msg.retry` command and the
// `message.updated` event that carries a refused row's cause back to every
// attached device.

import { describe, expect, it } from "vitest";

import {
  clientFrameSchema,
  type GatewayEvent,
  type MessageDto,
} from "./index.js";

const IDENTITY = "00000000-0000-7000-8000-000000000001";
const CONV = "00000000-0000-7000-8000-000000000002";

describe("msg.retry", () => {
  it("round-trips a retry command", () => {
    const frame = {
      t: "cmd",
      id: 7,
      d: {
        identityId: IDENTITY,
        action: "msg.retry",
        d: { convId: CONV, messageId: 4211 },
      },
    };
    const parsed = clientFrameSchema.parse(frame);
    expect(parsed).toEqual(frame);
  });

  it("rejects a malformed target", () => {
    for (const d of [
      { convId: "not-a-uuid", messageId: 1 },
      { convId: CONV, messageId: 0 },
      { convId: CONV, messageId: -3 },
      { convId: CONV, messageId: 1.5 },
      { convId: CONV },
    ]) {
      expect(
        clientFrameSchema.safeParse({
          t: "cmd",
          id: 1,
          d: { identityId: IDENTITY, action: "msg.retry", d },
        }).success,
      ).toBe(false);
    }
  });
});

describe("message.updated", () => {
  it("carries the full row, with and without a failure", () => {
    const base: MessageDto = {
      id: 12,
      senderCharacter: "Amber Vale",
      kind: "pm",
      bbcode: "are you there?",
      sentByUs: true,
      mention: false,
      createdAt: "2026-08-04T10:00:00.000Z",
    };
    // Failure state is a property of the row, not of the event: the same
    // shape says "this failed" and (after a retry) "it no longer does".
    const failed: GatewayEvent = {
      kind: "message.updated",
      d: {
        convId: CONV,
        message: { ...base, failureReason: "Nyx is offline" },
      },
    };
    const cleared: GatewayEvent = {
      kind: "message.updated",
      d: { convId: CONV, message: base },
    };
    expect(failed.d.message.failureReason).toBe("Nyx is offline");
    expect(cleared.d.message.failureReason).toBeUndefined();
    expect(cleared.d.message.id).toBe(failed.d.message.id);
  });
});
