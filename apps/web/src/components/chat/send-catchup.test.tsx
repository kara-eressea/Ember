// @vitest-environment jsdom
//
// Sending is a catch-up gesture (#415 family): "I don't care about the old
// history, I just want to participate in the new one." A composer send has to
// clear the conversation's unread state exactly like Esc / scrolling to the
// tail — badges gone, read cursor advanced, bar and in-log divider dismissed.
//
// The log and the composer are siblings, so this renders both against the same
// conversation — the seam between them (the messages store's send-catch-up
// signal) is what these assertions actually exercise.

import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PREFS_DEFAULTS } from "@emberchat/protocol";
import type { MessageDto } from "@emberchat/protocol";
import { Composer } from "./Composer.js";
import { MessageLog } from "./MessageLog.js";
import { useMessagesStore } from "../../stores/messages.js";
import {
  useSessionsStore,
  type ChannelView,
  type IdentitySession,
} from "../../stores/sessions.js";

vi.mock("../../gateway/socket.js", () => ({
  gateway: {
    cmd: vi.fn().mockResolvedValue({ ok: true }),
    readAck: vi.fn(),
  },
}));
const { gateway } = await import("../../gateway/socket.js");
// eslint-disable-next-line @typescript-eslint/unbound-method -- vitest mock fn, never reads `this`
const cmd = vi.mocked(gateway.cmd);
// eslint-disable-next-line @typescript-eslint/unbound-method -- vitest mock fn, never reads `this`
const readAck = vi.mocked(gateway.readAck);

class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
globalThis.ResizeObserver ??=
  ResizeObserverStub as unknown as typeof ResizeObserver;

// jsdom lays nothing out: a zero-height viewport makes the virtualizer render
// no rows at all, so give the scroll container a height (as OwnMessageTint
// does) and the overscan covers this handful of rows.
Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
  configurable: true,
  value: 600,
});

const IDENTITY = "id1";
const CONV = "c1";
const KEY = "adh-1";
/** The read cursor at attach: message 1 is read, 2 and 3 are new. */
const READ_CURSOR = 1;
const NEWEST = 3;

function channel(): ChannelView {
  return {
    convId: CONV,
    key: KEY,
    title: "Test Room",
    description: "",
    mode: "chat",
    oplist: [],
    members: [],
    seen: [],
    joined: true,
    pinned: false,
    unread: 2,
    mentions: 1,
    highlightedAt: 0,
    lastReadMessageId: READ_CURSOR,
    newestMessageId: NEWEST,
  };
}

function session(sendDelaySeconds: number): IdentitySession {
  return {
    identityId: IDENTITY,
    character: "Me",
    sessionStatus: "online",
    ownStatus: "online",
    ownStatusmsg: "",
    ignores: [],
    invites: [],
    limits: { chatMax: 4096, privMax: 50000, lfrpMax: 50000, lfrpFlood: 600 },
    iconBlacklist: [],
    chatop: false,
    sendDelaySeconds,
    prefs: PREFS_DEFAULTS,
    outbox: [],
    campaign: null,
    channels: { [KEY]: channel() },
    dms: {},
    channelByConvId: { [CONV]: KEY },
    synced: true,
    social: {
      bookmarks: [],
      friends: [],
      incoming: [],
      outgoing: [],
      fetchedAt: Date.now(),
    },
  };
}

function message(id: number): MessageDto {
  return {
    id,
    senderCharacter: "Nyx",
    kind: "msg",
    bbcode: `line ${String(id)}`,
    sentByUs: false,
    mention: false,
    createdAt: new Date("2026-08-01T12:00:00Z").toISOString(),
  };
}

function renderConversation(sendDelaySeconds: number): void {
  useSessionsStore.setState({
    sessions: { [IDENTITY]: session(sendDelaySeconds) },
  });
  useMessagesStore.setState({
    buffers: {
      [CONV]: {
        messages: [message(1), message(2), message(NEWEST)],
        presence: [],
        hasMoreBefore: false,
        backfilled: true,
        loadingOlder: false,
        detachedTail: false,
      },
    },
    jumpTarget: undefined,
  });
  render(
    <>
      <MessageLog
        identityId={IDENTITY}
        convId={CONV}
        readCursorAtAttach={READ_CURSOR}
      />
      <Composer
        session={useSessionsStore.getState().sessions[IDENTITY]!}
        convId={CONV}
        channelKey={KEY}
        channelMode="chat"
        placeholder="Message #Test Room"
        maxBytes={4096}
      />
    </>,
  );
}

const unread = () => {
  const view = useSessionsStore.getState().sessions[IDENTITY]?.channels[KEY];
  return { unread: view?.unread, mentions: view?.mentions };
};

const initialSessions = useSessionsStore.getState().sessions;
afterEach(() => {
  useSessionsStore.setState({ sessions: initialSessions });
  useMessagesStore.getState().reset();
  vi.clearAllMocks();
});

describe("a send marks the conversation caught up (#415 family)", () => {
  it("clears the badges, acks the read cursor and drops the divider", async () => {
    const user = userEvent.setup();
    renderConversation(0);
    // The unread state we are about to walk away from.
    expect(screen.getByTestId("new-divider")).toBeTruthy();
    expect(unread()).toEqual({ unread: 2, mentions: 1 });

    await user.type(screen.getByLabelText("Message"), "hello{Enter}");

    await waitFor(() => {
      expect(screen.queryByTestId("new-divider")).toBeNull();
    });
    expect(unread()).toEqual({ unread: 0, mentions: 0 });
    // Persisted, so the catch-up converges on every other attached device.
    expect(readAck).toHaveBeenCalledWith(IDENTITY, CONV, NEWEST);
  });

  it("leaves the unread state alone for a delayed send", async () => {
    const user = userEvent.setup();
    renderConversation(30);

    await user.type(screen.getByLabelText("Message"), "later{Enter}");

    // The message went out (into the server outbox) …
    await waitFor(() => {
      expect(cmd).toHaveBeenCalledWith(
        expect.objectContaining({ action: "msg.send" }),
      );
    });
    // … but a message that releases minutes from now is not a present-tense
    // catch-up gesture: it must not eat unread the user never saw.
    expect(readAck).not.toHaveBeenCalled();
    expect(unread()).toEqual({ unread: 2, mentions: 1 });
    expect(screen.getByTestId("new-divider")).toBeTruthy();
  });
});
