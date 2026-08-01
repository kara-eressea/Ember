// @vitest-environment jsdom
//
// Component-render tier: the own-message tint. `sentByUs` rides the message
// DTO, so the row treatment never depends on comparing sender names — this
// locks that wiring, plus the pref gate. jsdom applies no stylesheet, so the
// wash itself lives in chat.module.css (and its neutral derivation in
// theme.ts); what is testable here is which rows are marked.

import { afterEach, describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import type { MessageDto } from "@emberchat/protocol";
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

// jsdom lays nothing out, so every offsetHeight is 0 — and a zero-height
// scroll viewport makes the virtualizer render no rows at all. One non-zero
// height is enough: the log's overscan then covers this handful of rows.
Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
  configurable: true,
  value: 600,
});

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
    members: [],
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

function seedSession(ownMessageTint: boolean): void {
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
    prefs: { ...PREFS_DEFAULTS, ownMessageTint },
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

function message(id: number, sentByUs: boolean): MessageDto {
  return {
    id,
    senderCharacter: sentByUs ? "Me" : "Nyx",
    kind: "msg",
    bbcode: sentByUs ? "mine" : "theirs",
    sentByUs,
    mention: false,
    createdAt: new Date("2026-08-01T12:00:00Z").toISOString(),
  };
}

function seedBuffer(): void {
  useMessagesStore.setState({
    buffers: {
      [CONV]: {
        messages: [message(1, false), message(2, true)],
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

function renderLog(ownMessageTint: boolean): void {
  seedSession(ownMessageTint);
  seedBuffer();
  render(
    <MessageLog
      identityId={IDENTITY}
      convId={CONV}
      readCursorAtAttach={null}
    />,
  );
}

/** The message line for a body text — the nearest div ancestor, since
 * everything between it and the text is a span. */
function rowFor(text: string): HTMLElement {
  const row = screen.getByText(text).closest("div");
  expect(row).not.toBeNull();
  return row as HTMLElement;
}

const initialSessions = useSessionsStore.getState().sessions;
afterEach(() => {
  useSessionsStore.setState({ sessions: initialSessions });
  useMessagesStore.getState().reset();
});

describe("own-message tint", () => {
  it("marks the rows we sent and leaves everyone else's alone", () => {
    renderLog(true);
    expect(rowFor("mine").dataset["own"]).toBe("true");
    expect(rowFor("theirs").dataset["own"]).toBeUndefined();
  });

  it("marks nothing when the pref is off", () => {
    renderLog(false);
    expect(rowFor("mine").dataset["own"]).toBeUndefined();
    expect(rowFor("theirs").dataset["own"]).toBeUndefined();
  });
});
