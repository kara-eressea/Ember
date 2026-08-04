// @vitest-environment jsdom
//
// Component-render tier: the message-body face (`messageFont` pref, parked
// 2026-08-01 and built with the #492 round). It rides the same plumbing as the
// size ramp — a custom property on the log root — so this test locks the same
// thing MessageFontSize.test.tsx locks: the JS half. Which elements read the
// var is the stylesheet's business, and jsdom applies no CSS-module sheet.
//
// "sans" resolves to `inherit` on purpose: the default must be today's exact
// rendering, with the app body face reaching the row rather than a copy of the
// base.css stack that can drift from it.

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

function seedSession(messageFont: UserPrefs["messageFont"]): void {
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
    prefs: { ...PREFS_DEFAULTS, messageFont },
    outbox: [],
    campaign: null,
    channels: { [KEY]: channel() },
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

function renderLog(messageFont: UserPrefs["messageFont"]): HTMLElement {
  seedSession(messageFont);
  seedBuffer();
  render(
    <MessageLog
      identityId={IDENTITY}
      convId={CONV}
      readCursorAtAttach={null}
    />,
  );
  return screen.getByTestId("message-log");
}

describe("message log follows the message font pref", () => {
  it("leaves the default face inherited from the app", () => {
    expect(PREFS_DEFAULTS.messageFont).toBe("sans");
    expect(renderLog("sans").style.getPropertyValue("--eb-msg-family")).toBe(
      "inherit",
    );
  });

  it("sets a serif stack", () => {
    expect(renderLog("serif").style.getPropertyValue("--eb-msg-family")).toBe(
      'Georgia, "Times New Roman", Times, serif',
    );
  });

  it("sets the mono the app already loads", () => {
    expect(renderLog("mono").style.getPropertyValue("--eb-msg-family")).toBe(
      '"IBM Plex Mono", ui-monospace, monospace',
    );
  });

  it("leaves the size ramp alone — the two prefs are independent", () => {
    const log = renderLog("mono");
    expect(log.style.getPropertyValue("--eb-msg-font")).toBe("14px");
  });
});
