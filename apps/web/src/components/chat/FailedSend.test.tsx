// @vitest-environment jsdom
//
// The failed-DM row (#491): a message F-Chat refused renders marked, with its
// cause under it and a retry that waits for the partner to come back. The
// colour lives in chat.module.css (jsdom applies no stylesheet); what is
// testable here is which rows are marked, what they say, and what the retry
// sends. The store half — a `message.updated` replacing a buffered row in
// place — is asserted alongside, since the two are one feature.

import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { MessageDto } from "@emberchat/protocol";
import { PREFS_DEFAULTS } from "@emberchat/protocol";
import { MessageLog } from "./MessageLog.js";
import { useMessagesStore } from "../../stores/messages.js";
import {
  useSessionsStore,
  type DmView,
  type IdentitySession,
} from "../../stores/sessions.js";

const { cmdMock } = vi.hoisted(() => ({
  cmdMock: vi.fn().mockResolvedValue({ ok: true }),
}));
vi.mock("../../gateway/socket.js", () => ({
  gateway: { cmd: cmdMock, ackRead: vi.fn() },
}));

class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
globalThis.ResizeObserver ??=
  ResizeObserverStub as unknown as typeof ResizeObserver;

// jsdom lays nothing out; one non-zero height is enough for the virtualizer
// to render this handful of rows (see OwnMessageTint.test.tsx).
Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
  configurable: true,
  value: 600,
});

const IDENTITY = "id1";
const CONV = "c1";
const PARTNER = "Nyx Firemane";

function dm(online: boolean): DmView {
  return {
    convId: CONV,
    partner: PARTNER,
    title: PARTNER,
    online,
    status: online ? "online" : "",
    statusmsg: "",
    pinned: false,
    typing: "clear",
    unread: 0,
    highlightedAt: 0,
    lastReadMessageId: null,
    newestMessageId: null,
  };
}

function seedSession(partnerOnline: boolean): void {
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
    prefs: { ...PREFS_DEFAULTS },
    outbox: [],
    campaign: null,
    channels: {},
    dms: { [CONV]: dm(partnerOnline) },
    channelByConvId: {},
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

function message(id: number, failureReason?: string): MessageDto {
  return {
    id,
    senderCharacter: "Me",
    kind: "pm",
    bbcode: id === 2 ? "are you there?" : "hello",
    sentByUs: true,
    mention: false,
    createdAt: new Date("2026-08-04T12:00:00Z").toISOString(),
    ...(failureReason !== undefined ? { failureReason } : {}),
  };
}

function seedBuffer(messages: MessageDto[]): void {
  useMessagesStore.setState({
    buffers: {
      [CONV]: {
        messages,
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

function renderLog(partnerOnline: boolean, messages: MessageDto[]): void {
  seedSession(partnerOnline);
  seedBuffer(messages);
  render(
    <MessageLog
      identityId={IDENTITY}
      convId={CONV}
      readCursorAtAttach={null}
    />,
  );
}

const initialSessions = useSessionsStore.getState().sessions;
afterEach(() => {
  useSessionsStore.setState({ sessions: initialSessions });
  useMessagesStore.getState().reset();
  cmdMock.mockClear();
});

describe("failed DM row", () => {
  it("marks only the refused message and names the cause", () => {
    renderLog(true, [message(1), message(2, `${PARTNER} is offline`)]);

    const failed = screen.getAllByTestId("failed-send");
    expect(failed).toHaveLength(1);
    expect(failed[0]!.textContent).toContain("are you there?");
    expect(screen.getByTestId("failed-send-reason").textContent).toBe(
      `Not sent — ${PARTNER} is offline`,
    );
    // The message it did not fail on renders as an ordinary line.
    expect(screen.getByText("hello").closest("[data-failed]")).toBeNull();
  });

  it("waits for the partner before offering the retry", () => {
    renderLog(false, [message(2, `${PARTNER} is offline`)]);
    const retry = screen.getByTestId("failed-send-retry");
    expect(retry).toBeDisabled();
    expect(retry.title).toBe("Available when they come back online");
  });

  it("re-sends the same row when the partner is back", async () => {
    renderLog(true, [message(2, `${PARTNER} is offline`)]);
    await userEvent.click(screen.getByTestId("failed-send-retry"));

    expect(cmdMock).toHaveBeenCalledWith({
      identityId: IDENTITY,
      action: "msg.retry",
      d: { convId: CONV, messageId: 2 },
    });
  });

  it("surfaces a refused retry in place of the original cause", async () => {
    cmdMock.mockResolvedValueOnce({
      ok: false,
      error: "session not connected",
    });
    renderLog(true, [message(2, `${PARTNER} is offline`)]);
    await userEvent.click(screen.getByTestId("failed-send-retry"));

    expect(screen.getByTestId("failed-send-reason").textContent).toBe(
      "Not sent — session not connected",
    );
  });
});

describe("message.updated in the buffer", () => {
  it("replaces a buffered row in place", () => {
    seedBuffer([message(1), message(2)]);
    useMessagesStore
      .getState()
      .applyUpdate(CONV, message(2, `${PARTNER} is offline`));

    const buffer = useMessagesStore.getState().buffers[CONV]!;
    expect(buffer.messages).toHaveLength(2);
    expect(buffer.messages[1]!.failureReason).toBe(`${PARTNER} is offline`);
    // …and clears again when a retry goes through.
    useMessagesStore.getState().applyUpdate(CONV, message(2));
    expect(
      useMessagesStore.getState().buffers[CONV]!.messages[1]!.failureReason,
    ).toBeUndefined();
  });

  it("never inserts a row the buffer does not hold", () => {
    seedBuffer([message(1)]);
    useMessagesStore.getState().applyUpdate(CONV, message(2, "gone"));
    useMessagesStore.getState().applyUpdate("other", message(1, "gone"));

    expect(useMessagesStore.getState().buffers[CONV]!.messages).toHaveLength(1);
    expect(useMessagesStore.getState().buffers["other"]).toBeUndefined();
  });
});
