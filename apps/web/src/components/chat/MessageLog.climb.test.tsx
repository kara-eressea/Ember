// @vitest-environment jsdom
//
// The #514 climb gate: a bottom-directed write must never land on a reader who
// is scrolling away from the tail.
//
// The subject here is the #284 re-stick observer, because it is the one writer
// whose trigger a unit test can produce on demand — geometry moving with no
// scroll event behind it is exactly one ResizeObserver callback. What it must
// do is unchanged (a parked log gets glued back to the newest message) and what
// it must now refuse to do is the bug: doing that to someone mid-climb throws
// them at the tail AND resets the distance they had built toward the stick's
// release, so with finger-sized increments they never get out.
//
// Direction is read from the INPUT rather than from the scroll it causes, which
// is what makes both halves testable without laying anything out: a wheel tick's
// sign, and which way a finger travelled between two touchmoves. The scale of
// the defect, and the second writer (the arrival path's settle pass), are
// measured on a real engine in e2e/history-climb.spec.ts and its phone twin.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

/** Every ResizeObserver the render creates, so a test can fire them by hand —
 * "the log's geometry moved with nothing else to announce it". */
const observers: ((entries: unknown[]) => void)[] = [];
class ResizeObserverStub {
  constructor(callback: (entries: unknown[]) => void) {
    observers.push(callback);
  }
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
globalThis.ResizeObserver =
  ResizeObserverStub as unknown as typeof ResizeObserver;

// jsdom lays nothing out, so a zero-height viewport makes the virtualizer
// render no rows at all (OwnMessageTint's note).
Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
  configurable: true,
  value: 600,
});

const IDENTITY = "id1";
const CONV = "c1";
const KEY = "adh-1";
/** The scroll geometry the test gives the log: a tall backlog in a short
 * viewport, so "the bottom" is a number the assertions can name. */
const SCROLL_HEIGHT = 4000;
const CLIENT_HEIGHT = 600;
const BOTTOM = SCROLL_HEIGHT - CLIENT_HEIGHT;
/** Where the reader is parked for each case: a little way up the log, well
 * inside the stick's release hysteresis so the intent is still held — the band
 * the whole bug lives in. */
const READING_AT = BOTTOM - 90;

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
    prefs: PREFS_DEFAULTS,
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
    senderCharacter: "Sedge Warbler",
    kind: "msg",
    bbcode: "a long roleplay post",
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

/** Render the log and give it a scroll geometry jsdom will not: a real
 * scrollTop the component can read back, and a tall content box. */
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
  const log = screen.getByTestId("message-log");
  let scrollTop = BOTTOM;
  Object.defineProperty(log, "scrollTop", {
    configurable: true,
    get: () => scrollTop,
    set: (value: number) => {
      scrollTop = Math.min(value, BOTTOM);
    },
  });
  Object.defineProperty(log, "scrollHeight", {
    configurable: true,
    get: () => SCROLL_HEIGHT,
  });
  Object.defineProperty(log, "clientHeight", {
    configurable: true,
    get: () => CLIENT_HEIGHT,
  });
  return log;
}

/** The log's geometry moved with no scroll event behind it (#284). Every
 * observer the render installed is fired, the virtualizer's included — with no
 * entries, since what is under test is the log's own reaction and not a
 * particular row changing size. */
function geometryMoved(): void {
  for (const callback of observers) {
    callback([]);
  }
}

function wheel(log: HTMLElement, deltaY: number): void {
  log.dispatchEvent(new WheelEvent("wheel", { deltaY, bubbles: true }));
}

/** jsdom has no TouchEvent constructor, and the handler reads one field. */
function touch(log: HTMLElement, type: string, clientY: number): void {
  const event = new Event(type, { bubbles: true });
  log.dispatchEvent(Object.assign(event, { touches: [{ clientY }] }));
}

const initialSessions = useSessionsStore.getState().sessions;
beforeEach(() => {
  observers.length = 0;
});
afterEach(() => {
  useSessionsStore.setState({ sessions: initialSessions });
  useMessagesStore.getState().reset();
});

describe("the bottom-stick re-stick observer", () => {
  it("glues a parked log back to the newest message (#284)", () => {
    const log = renderLog();
    log.scrollTop = READING_AT;
    geometryMoved();
    expect(log.scrollTop).toBe(BOTTOM);
  });

  it("leaves a reader wheeling away from the tail alone (#514)", () => {
    const log = renderLog();
    wheel(log, -100);
    log.scrollTop = READING_AT;
    geometryMoved();
    expect(log.scrollTop).toBe(READING_AT);
  });

  it("still glues when the reader is wheeling toward the tail", () => {
    const log = renderLog();
    wheel(log, -100);
    wheel(log, 100);
    log.scrollTop = READING_AT;
    geometryMoved();
    expect(log.scrollTop).toBe(BOTTOM);
  });

  it("reads a finger dragging the content down as a climb", () => {
    const log = renderLog();
    touch(log, "touchstart", 300);
    touch(log, "touchmove", 380);
    log.scrollTop = READING_AT;
    geometryMoved();
    expect(log.scrollTop).toBe(READING_AT);
  });

  it("reads a finger chasing the newest as no climb", () => {
    const log = renderLog();
    touch(log, "touchstart", 380);
    touch(log, "touchmove", 300);
    log.scrollTop = READING_AT;
    geometryMoved();
    expect(log.scrollTop).toBe(BOTTOM);
  });

  it("resumes once the reader's hands have been off long enough", async () => {
    const log = renderLog();
    wheel(log, -100);
    // Past SCROLL_INTENT_WINDOW_MS: the climb is over, and a log left short of
    // the tail with the intent still held is the #284 case again.
    await new Promise((resolve) => setTimeout(resolve, 600));
    log.scrollTop = READING_AT;
    geometryMoved();
    expect(log.scrollTop).toBe(BOTTOM);
  });
});
