// @vitest-environment jsdom
//
// Component-render tier: the message log's own type ramp (#380 / #381). The
// message font-size pref drives two custom properties on the log root —
// `--eb-msg-font` (body + sender name) and `--eb-msg-meta-font` (timestamps,
// date/new dividers, the queued-send countdown). Every line variant inherits
// those, so names, timestamps, and the dividers between messages all scale
// with the message font instead of the interface font scale.
//
// jsdom does not apply the CSS-module stylesheet, so the concrete px values
// live in the stylesheet, not here; this test locks the JS plumbing that feeds
// it — the root vars per pref step — which is exactly what regressed when a
// line variant was wired to `--eb-font-ui-scale` by mistake.

import { afterEach, describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import type { MessageDto, UserPrefs } from "@emberchat/protocol";
import { PREFS_DEFAULTS } from "@emberchat/protocol";
import { MessageLog } from "./MessageLog.js";
import { useMessagesStore } from "../../stores/messages.js";
import {
  useSessionsStore,
  type ChannelView,
  type IdentitySession,
} from "../../stores/sessions.js";

// The log installs a ResizeObserver to re-stick the bottom; jsdom has none.
// A no-op stub is enough — this test never exercises scroll geometry.
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
globalThis.ResizeObserver ??=
  ResizeObserverStub as unknown as typeof ResizeObserver;

const IDENTITY = "id1";
const CONV = "c1";
const KEY = "adh-1";

function channel(): ChannelView {
  return {
    convId: CONV,
    key: KEY,
    title: "Test Room",
    description: "",
    mode: "both",
    oplist: [],
    members: [
      { character: "Nyx", gender: "Male", status: "online", statusmsg: "" },
    ],
    seen: [],
    joined: true,
    pinned: false,
    unread: 0,
    mentions: 0,
    highlightedAt: 0,
    lastReadMessageId: null,
    newestMessageId: null,
  };
}

function seedSession(fontSize: UserPrefs["fontSize"]): void {
  const ch = channel();
  const session: IdentitySession = {
    identityId: IDENTITY,
    character: "Me",
    sessionStatus: "online",
    ownStatus: "online",
    ownStatusmsg: "",
    ignores: [],
    limits: { chatMax: 4096, privMax: 50000, lfrpMax: 50000, lfrpFlood: 600 },
    iconBlacklist: [],
    chatop: false,
    sendDelaySeconds: 0,
    prefs: { ...PREFS_DEFAULTS, fontSize },
    outbox: [],
    campaign: null,
    channels: { [KEY]: ch },
    dms: {},
    channelByConvId: { [CONV]: KEY },
    synced: true,
    invites: [],
    social: {
      bookmarks: [],
      friends: [],
      incoming: [],
      outgoing: [],
      fetchedAt: Date.now(),
    },
  };
  useSessionsStore.setState({ sessions: { [IDENTITY]: session } });
}

function seedBuffer(): void {
  const msg: MessageDto = {
    id: 1,
    senderCharacter: "Nyx",
    kind: "msg",
    bbcode: "hello there",
    sentByUs: false,
    mention: false,
    createdAt: new Date("2026-07-23T12:00:00Z").toISOString(),
  };
  useMessagesStore.setState({
    buffers: {
      [CONV]: {
        messages: [msg],
        presence: [],
        hasMoreBefore: false,
        backfilled: true,
        loadingOlder: false,
        detachedTail: false,
      },
    },
    jumpTarget: undefined,
  });
}

const initialSessions = useSessionsStore.getState().sessions;
afterEach(() => {
  useSessionsStore.setState({ sessions: initialSessions });
  useMessagesStore.getState().reset();
});

/** The message ramp values baked into the appearance pref (mirrors the
 * FONT_RAMP_PX table in MessageLog). Kept here so a change to the ramp has to
 * be made deliberately in both places. */
const RAMP = {
  s: { body: "13px", meta: "11.5px" },
  m: { body: "14px", meta: "12px" },
  l: { body: "15px", meta: "13px" },
} as const;

describe("message log follows the message font size (#380/#381)", () => {
  for (const size of ["s", "m", "l"] as const) {
    it(`sets --eb-msg-font/--eb-msg-meta-font from the '${size}' message font pref`, () => {
      seedSession(size);
      seedBuffer();
      render(
        <MessageLog
          identityId={IDENTITY}
          convId={CONV}
          readCursorAtAttach={null}
        />,
      );
      const log = screen.getByTestId("message-log");
      expect(log.style.getPropertyValue("--eb-msg-font")).toBe(RAMP[size].body);
      expect(log.style.getPropertyValue("--eb-msg-meta-font")).toBe(
        RAMP[size].meta,
      );
    });
  }

  it("scales the message font vars independently of the interface font scale", () => {
    // The interface scale lives on :root (--eb-font-ui-scale); the message ramp
    // must never read it, or bumping the message size would drag the chrome
    // along (and vice versa). The log root carries only the message vars.
    seedSession("l");
    seedBuffer();
    render(
      <MessageLog
        identityId={IDENTITY}
        convId={CONV}
        readCursorAtAttach={null}
      />,
    );
    const log = screen.getByTestId("message-log");
    expect(log.style.getPropertyValue("--eb-msg-font")).toBe("15px");
    expect(log.style.getPropertyValue("--eb-font-ui-scale")).toBe("");
  });
});
