// @vitest-environment jsdom
//
// The phone override (#513): below 768px effective width the log renders the
// full-width inline flow whatever `alignedColumns` says, and the pull gesture
// is installed. jsdom applies no stylesheet, so what is testable here is the
// wiring — which shape the log declares it is in, that the pref is untouched
// above phone, and that a horizontal drag publishes the reveal offset while a
// vertical one leaves the scroll alone. The geometry itself (the stamp column,
// the translate) is measured in e2e/mobile-log-flow.spec.ts, on a real engine.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import type { MessageDto } from "@emberchat/protocol";
import { PREFS_DEFAULTS } from "@emberchat/protocol";
import { MessageLog } from "./MessageLog.js";
import { AXIS_LOCK_PX, REVEAL_VAR } from "./pull-reveal.js";
import { useMessagesStore } from "../../stores/messages.js";
import { setWindowWidth } from "../../test-support/dom.js";
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

// jsdom lays nothing out, so a zero-height viewport makes the virtualizer
// render no rows at all. One non-zero height is enough (OwnMessageTint's note).
Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
  configurable: true,
  value: 600,
});

const IDENTITY = "id1";
const CONV = "c1";
const KEY = "adh-1";
const PHONE_WIDTH = 393;
const DESKTOP_WIDTH = 1280;

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

function seedSession(): void {
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
    // The reported configuration: aligned columns ON, timestamps ON.
    prefs: { ...PREFS_DEFAULTS, alignedColumns: true },
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
  const message: MessageDto = {
    id: 1,
    senderCharacter: "Marwenna Wolfhammers",
    kind: "msg",
    bbcode: "a long roleplay post that has nowhere to wrap",
    sentByUs: false,
    mention: false,
    createdAt: new Date("2026-08-04T12:04:33Z").toISOString(),
  };
  useMessagesStore.setState({
    buffers: {
      [CONV]: {
        messages: [message],
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

function renderLog(): HTMLElement {
  seedSession();
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

/** A pointer event jsdom will dispatch — built by hand because jsdom has no
 * PointerEvent constructor, and the recognizer reads four fields. */
function pointer(type: string, x: number, y: number): Event {
  const event = new Event(type, { bubbles: true });
  return Object.assign(event, {
    pointerId: 1,
    pointerType: "touch",
    clientX: x,
    clientY: y,
  });
}

const initialSessions = useSessionsStore.getState().sessions;
afterEach(() => {
  useSessionsStore.setState({ sessions: initialSessions });
  useMessagesStore.getState().reset();
  setWindowWidth(1024); // jsdom's default
});

describe("aligned columns on a phone", () => {
  it("renders the inline flow even with the pref on", () => {
    setWindowWidth(PHONE_WIDTH);
    expect(renderLog()).toHaveAttribute("data-log-flow", "inline");
  });

  it("keeps honouring the pref above phone", () => {
    setWindowWidth(DESKTOP_WIDTH);
    expect(renderLog()).toHaveAttribute("data-log-flow", "aligned");
  });

  it("keeps the stamp in the DOM — it moves to the gutter, it is not dropped", () => {
    setWindowWidth(PHONE_WIDTH);
    renderLog();
    // The same element the desktop renders inline; the phone stylesheet takes
    // it out of flow so the pull has something to uncover. Matched by shape,
    // not by value — the runner's timezone decides the digits.
    expect(screen.getByText(/^\d{2}:\d{2}$/)).toBeTruthy();
  });
});

describe("the pull gesture", () => {
  beforeEach(() => {
    setWindowWidth(PHONE_WIDTH);
  });

  it("publishes the reveal offset for a horizontal drag", () => {
    const log = renderLog();
    log.dispatchEvent(pointer("pointerdown", 100, 300));
    log.dispatchEvent(pointer("pointermove", 100 + AXIS_LOCK_PX + 1, 301));
    log.dispatchEvent(pointer("pointermove", 100 + AXIS_LOCK_PX + 41, 301));
    expect(log.style.getPropertyValue(REVEAL_VAR)).toBe("40px");
  });

  it("publishes nothing for a vertical scroll", () => {
    const log = renderLog();
    log.dispatchEvent(pointer("pointerdown", 100, 300));
    log.dispatchEvent(pointer("pointermove", 102, 300 + AXIS_LOCK_PX + 1));
    log.dispatchEvent(pointer("pointermove", 220, 500));
    expect(log.style.getPropertyValue(REVEAL_VAR)).toBe("");
  });

  it("is not installed above phone", () => {
    setWindowWidth(DESKTOP_WIDTH);
    const log = renderLog();
    log.dispatchEvent(pointer("pointerdown", 100, 300));
    log.dispatchEvent(pointer("pointermove", 300, 301));
    expect(log.style.getPropertyValue(REVEAL_VAR)).toBe("");
  });
});
