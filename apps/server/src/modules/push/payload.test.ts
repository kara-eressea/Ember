// Payload shaping (design/web-push.md §3) — the half of the sender that a
// wire-level test cannot see, because the body reaching the push service is
// encrypted to the browser's keys. What goes INTO that ciphertext is the
// privacy contract (invariant 4), so it is asserted here instead.

import { describe, expect, it } from "vitest";
import { buildPushPayload, pushUrl } from "./sender.js";

const IDENTITY = "018f0000-0000-7000-8000-000000000001";
const CONV = "018f0000-0000-7000-8000-000000000002";

describe("buildPushPayload", () => {
  it("carries sender and excerpt when content is allowed", () => {
    expect(
      buildPushPayload(
        IDENTITY,
        "Amber Vale",
        {
          kind: "mention",
          character: "Nyx Firemane",
          excerpt: "hey Amber, over here",
          convId: CONV,
        },
        { notifyShowContent: true },
      ),
    ).toEqual({
      kind: "mention",
      identity: "Amber Vale",
      character: "Nyx Firemane",
      excerpt: "hey Amber, over here",
      convId: CONV,
      url: `/app/${IDENTITY}/${CONV}`,
    });
  });

  it("drops the excerpt when notifyShowContent is off", () => {
    const payload = buildPushPayload(
      IDENTITY,
      "Amber Vale",
      {
        kind: "pm",
        character: "Nyx Firemane",
        excerpt: "something private",
        convId: CONV,
      },
      { notifyShowContent: false },
    );
    // Who and where, never what — the existing desktop-notification privacy
    // toggle extends to push unchanged.
    expect(payload.excerpt).toBeUndefined();
    expect(payload).toMatchObject({
      kind: "pm",
      character: "Nyx Firemane",
      convId: CONV,
    });
    expect(JSON.stringify(payload)).not.toContain("something private");
  });

  it("omits an empty excerpt rather than sending a blank body", () => {
    // RTB events without a subject: an empty `body` on the notification is
    // worse than none at all.
    expect(
      buildPushPayload(
        IDENTITY,
        "Amber Vale",
        { kind: "friendrequest", character: "Nyx Firemane", excerpt: "" },
        { notifyShowContent: true },
      ),
    ).toEqual({
      kind: "friendrequest",
      identity: "Amber Vale",
      character: "Nyx Firemane",
      url: `/app/${IDENTITY}`,
    });
  });
});

describe("pushUrl", () => {
  it("routes to the conversation, or to the identity when there is none", () => {
    expect(pushUrl(IDENTITY, CONV)).toBe(`/app/${IDENTITY}/${CONV}`);
    expect(pushUrl(IDENTITY)).toBe(`/app/${IDENTITY}`);
  });
});
