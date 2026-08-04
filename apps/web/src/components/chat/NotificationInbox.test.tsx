// @vitest-environment jsdom
//
// The inbox chip and its dropdown (#467): the badge clears on open (the
// Discord model), each kind renders its own line, and a mention row hands the
// jump machinery the message it points at.
//
// Plus the two things a row can do: answer a friend request inline (#505) —
// including one answered somewhere else entirely — and delete the log line
// (#506), which must never act on what the line was about.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import type { NotificationDto } from "@emberchat/protocol";
import { api } from "../../lib/api.js";
import { loadSocial } from "../../lib/social.js";
import { useMessagesStore } from "../../stores/messages.js";
import { useNotificationsStore } from "../../stores/notifications.js";
import {
  useSessionsStore,
  type IdentitySession,
  type SocialData,
} from "../../stores/sessions.js";
import { useUiStore } from "../../stores/ui.js";
import {
  friendRequestState,
  InboxChip,
  notificationLine,
} from "./NotificationInbox.js";

vi.mock("../../lib/api.js", () => ({
  api: {
    listNotifications: vi.fn(),
    putNotificationsSeen: vi.fn(),
    deleteNotification: vi.fn(),
    postFriendRequest: vi.fn(),
    getSocial: vi.fn(),
  },
}));
// The panel warms the social lists on mount (the phone has no sidebar doing
// it); the tests drive those lists through the sessions store directly.
vi.mock("../../lib/social.js", () => ({
  loadSocial: vi.fn(() => Promise.resolve()),
}));

const mocked = vi.mocked(api);
const IDENTITY = "id-1";
const REQUESTER = "Tally Marsh";

const initialSessions = useSessionsStore.getState().sessions;

/** Just enough session for the row: the social lists it derives from. */
function seedSocial(social: Partial<SocialData>): void {
  useSessionsStore.setState({
    sessions: {
      [IDENTITY]: {
        identityId: IDENTITY,
        character: "Amber Vale",
        channels: {},
        dms: {},
        channelByConvId: {},
        social: {
          bookmarks: [],
          friends: [],
          incoming: [],
          outgoing: [],
          fetchedAt: Date.now(),
          ...social,
        },
      } as unknown as IdentitySession,
    },
  });
}

function friend(name: string) {
  return { name, online: true, status: "online", statusmsg: "" };
}

function entry(
  id: number,
  patch: Partial<NotificationDto> = {},
): NotificationDto {
  return {
    id,
    kind: "mention",
    convId: "conv-1",
    messageId: id * 10,
    character: "Nyx Firemane",
    excerpt: "look at this",
    muted: false,
    createdAt: new Date().toISOString(),
    ...patch,
  };
}

function serve(entries: NotificationDto[], unseen = entries.length) {
  mocked.listNotifications.mockResolvedValue({
    notifications: entries,
    hasMore: false,
    lastSeenId: 0,
    unseen,
  });
  mocked.putNotificationsSeen.mockResolvedValue({
    lastSeenId: entries[0]?.id ?? 0,
    unseen: 0,
  });
}

beforeEach(() => {
  useNotificationsStore.getState().reset();
  vi.clearAllMocks();
  vi.mocked(loadSocial).mockResolvedValue();
});

afterEach(() => {
  useMessagesStore.getState().reset();
  useSessionsStore.setState({ sessions: initialSessions });
});

function renderChip() {
  return render(
    <MemoryRouter>
      <InboxChip identityId={IDENTITY} />
    </MemoryRouter>,
  );
}

describe("InboxChip", () => {
  it("badges the unseen count and clears it when the inbox is opened", async () => {
    serve([entry(9), entry(8)]);
    useNotificationsStore.getState().applyUnseen(IDENTITY, 2);
    renderChip();

    const chip = screen.getByRole("button", {
      name: "Notifications — 2 unseen",
    });
    expect(chip).toHaveTextContent("2");

    await userEvent.click(chip);
    await screen.findByRole("dialog", { name: "Notifications" });
    // Opening marks everything seen — the user's chosen model.
    await waitFor(() => {
      expect(mocked.putNotificationsSeen.mock.calls).toEqual([[IDENTITY, 9]]);
    });
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Notifications" }),
      ).not.toHaveTextContent("2");
    });
  });

  it("renders a line per kind and jumps to a mention's message", async () => {
    serve([
      entry(9),
      entry(8, {
        kind: "friendrequest",
        character: "Tally Marsh",
        excerpt: "",
      }),
      entry(7, {
        kind: "note",
        character: "Old Greywhisker",
        excerpt: "About last night",
      }),
      entry(6, { kind: "comment", character: "Nyx Firemane", excerpt: "" }),
    ]);
    renderChip();
    await userEvent.click(
      screen.getByRole("button", { name: /Notifications/ }),
    );
    await screen.findByRole("dialog", { name: "Notifications" });

    expect(screen.getByText("Nyx Firemane mentioned you")).toBeInTheDocument();
    expect(screen.getByText("look at this")).toBeInTheDocument();
    expect(
      screen.getByText("Tally Marsh sent a friend request"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("New note from Old Greywhisker"),
    ).toBeInTheDocument();
    expect(screen.getByText("About last night")).toBeInTheDocument();
    expect(
      screen.getByText("Nyx Firemane replied to a comment thread you follow"),
    ).toBeInTheDocument();

    const jumpTo = vi
      .spyOn(useMessagesStore.getState(), "jumpTo")
      .mockResolvedValue();
    await userEvent.click(screen.getByText("Nyx Firemane mentioned you"));
    expect(jumpTo).toHaveBeenCalledWith(IDENTITY, "conv-1", 90);
    // Closing first is the point: the panel covers exactly the top of the log
    // the jump lands in.
    expect(
      screen.queryByRole("dialog", { name: "Notifications" }),
    ).not.toBeInTheDocument();
  });

  it("sends a friend request to the sidebar's request rows", async () => {
    serve([entry(9, { kind: "friendrequest", excerpt: "" })]);
    const before = useUiStore.getState().friendRequestsNonce;
    renderChip();
    await userEvent.click(
      screen.getByRole("button", { name: /Notifications/ }),
    );
    await screen.findByRole("dialog", { name: "Notifications" });
    await userEvent.click(
      screen.getByText("Nyx Firemane sent a friend request"),
    );
    expect(useUiStore.getState().friendRequestsNonce).toBe(before + 1);
  });

  it("says so when the inbox is empty, and when the fetch failed", async () => {
    serve([], 0);
    renderChip();
    await userEvent.click(
      screen.getByRole("button", { name: "Notifications" }),
    );
    expect(await screen.findByText(/Nothing here yet/)).toBeInTheDocument();

    await userEvent.keyboard("{Escape}");
    mocked.listNotifications.mockRejectedValue(new Error("offline"));
    useNotificationsStore.getState().reset();
    await userEvent.click(
      screen.getByRole("button", { name: "Notifications" }),
    );
    expect(
      await screen.findByText("Couldn't load your notifications."),
    ).toBeInTheDocument();
  });
});

/** Opens the panel and waits for it. */
async function openPanel() {
  await userEvent.click(screen.getByRole("button", { name: /Notifications/ }));
  return screen.findByRole("dialog", { name: "Notifications" });
}

describe("friend requests answered inline (#505)", () => {
  const request = () =>
    entry(9, { kind: "friendrequest", character: REQUESTER, excerpt: "" });

  it("offers the two answers while the request is pending, and resolves the row on the click", async () => {
    serve([request()]);
    mocked.postFriendRequest.mockResolvedValue({ ok: true });
    seedSocial({ incoming: [{ id: 42, name: REQUESTER }] });
    renderChip();
    await openPanel();

    const accept = await screen.findByRole("button", {
      name: `Accept friend request from ${REQUESTER}`,
    });
    // Glyph-only, never semantically: the name comes off the label, and the
    // button has no text of its own.
    expect(accept).toHaveTextContent("");
    expect(
      screen.getByRole("button", {
        name: `Decline friend request from ${REQUESTER}`,
      }),
    ).toBeInTheDocument();

    await userEvent.click(accept);
    // The same endpoint (and the same forced refetch) the sidebar rows use.
    expect(mocked.postFriendRequest.mock.calls).toEqual([
      [IDENTITY, { action: "accept", requestId: 42 }],
    ]);
    await waitFor(() => {
      expect(vi.mocked(loadSocial)).toHaveBeenCalledWith(IDENTITY, true);
    });
    // Resolved immediately — the row does not wait out the refetch wearing
    // buttons that would act on a request that is already gone.
    expect(await screen.findByText("Accepted")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", {
        name: `Accept friend request from ${REQUESTER}`,
      }),
    ).not.toBeInTheDocument();
  });

  it("puts the buttons back when the answer failed", async () => {
    serve([request()]);
    mocked.postFriendRequest.mockRejectedValue(new Error("offline"));
    seedSocial({ incoming: [{ id: 42, name: REQUESTER }] });
    renderChip();
    await openPanel();

    await userEvent.click(
      await screen.findByRole("button", {
        name: `Decline friend request from ${REQUESTER}`,
      }),
    );
    expect(
      await screen.findByText("Couldn't answer that friend request."),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: `Accept friend request from ${REQUESTER}`,
      }),
    ).toBeInTheDocument();
  });

  it("follows a request resolved on another device or on the website", async () => {
    // Nothing this client did: the request simply left `incoming` and the
    // character is a friend now — an accept that happened elsewhere.
    serve([request()]);
    seedSocial({ friends: [friend(REQUESTER)] });
    renderChip();
    await openPanel();
    expect(await screen.findByText("Accepted")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", {
        name: `Accept friend request from ${REQUESTER}`,
      }),
    ).not.toBeInTheDocument();

    // Gone from both lists: declined, wherever it happened.
    seedSocial({});
    expect(await screen.findByText("Declined")).toBeInTheDocument();
  });

  it("offers nothing at all before the social lists have landed", async () => {
    serve([request()]);
    renderChip();
    await openPanel();
    expect(
      await screen.findByText(`${REQUESTER} sent a friend request`),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", {
        name: `Accept friend request from ${REQUESTER}`,
      }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Declined")).not.toBeInTheDocument();
    // …and the panel asked for them, because on a phone nothing else has.
    expect(vi.mocked(loadSocial)).toHaveBeenCalledWith(IDENTITY);
  });
});

describe("per-entry delete (#506)", () => {
  it("drops the row and takes the server's recounted badge", async () => {
    serve([entry(9), entry(8, { kind: "note", character: "Old Greywhisker" })]);
    // The recount, not a decrement: whatever the server says is the badge.
    mocked.deleteNotification.mockResolvedValue({ removed: true, unseen: 2 });
    renderChip();
    await openPanel();
    await screen.findByText("Nyx Firemane mentioned you");

    const bins = screen.getAllByRole("button", {
      name: "Remove notification",
    });
    expect(bins).toHaveLength(2);
    await userEvent.click(bins[0]!);

    expect(mocked.deleteNotification.mock.calls).toEqual([[IDENTITY, 9]]);
    await waitFor(() => {
      expect(
        screen.queryByText("Nyx Firemane mentioned you"),
      ).not.toBeInTheDocument();
    });
    expect(
      screen.getByText("New note from Old Greywhisker"),
    ).toBeInTheDocument();
    expect(useNotificationsStore.getState().byIdentity[IDENTITY]?.unseen).toBe(
      2,
    );
  });

  it("removes a friend-request line without answering the request", async () => {
    serve([entry(9, { kind: "friendrequest", character: REQUESTER })]);
    mocked.deleteNotification.mockResolvedValue({ removed: true, unseen: 0 });
    seedSocial({ incoming: [{ id: 42, name: REQUESTER }] });
    renderChip();
    await openPanel();

    await userEvent.click(
      await screen.findByRole("button", { name: "Remove notification" }),
    );
    await waitFor(() => {
      expect(
        screen.queryByText(`${REQUESTER} sent a friend request`),
      ).not.toBeInTheDocument();
    });
    // The log line went; the request itself is untouched, still pending on
    // every other surface.
    expect(mocked.postFriendRequest.mock.calls).toEqual([]);
  });

  it("says so when the delete failed, and keeps the row", async () => {
    serve([entry(9)]);
    mocked.deleteNotification.mockRejectedValue(new Error("offline"));
    renderChip();
    await openPanel();
    await userEvent.click(
      await screen.findByRole("button", { name: "Remove notification" }),
    );
    expect(
      await screen.findByText("Couldn't remove that notification."),
    ).toBeInTheDocument();
    expect(screen.getByText("Nyx Firemane mentioned you")).toBeInTheDocument();
  });

  it("drops a row another device deleted, badge and all", async () => {
    serve([entry(9), entry(8, { kind: "note", character: "Old Greywhisker" })]);
    renderChip();
    await openPanel();
    await screen.findByText("Nyx Firemane mentioned you");

    // What dispatch does with a notification.removed frame.
    useNotificationsStore.getState().applyRemoved(IDENTITY, 9, 1);
    await waitFor(() => {
      expect(
        screen.queryByText("Nyx Firemane mentioned you"),
      ).not.toBeInTheDocument();
    });
    expect(useNotificationsStore.getState().byIdentity[IDENTITY]?.unseen).toBe(
      1,
    );
  });
});

describe("friendRequestState", () => {
  const request = entry(9, { kind: "friendrequest", character: REQUESTER });
  const lists = (patch: Partial<SocialData>): SocialData => ({
    bookmarks: [],
    friends: [],
    incoming: [],
    outgoing: [],
    fetchedAt: 0,
    ...patch,
  });

  it("reads the live lists, case-insensitively", () => {
    expect(
      friendRequestState(
        request,
        lists({ incoming: [{ id: 7, name: "tally marsh" }] }),
        undefined,
      ),
    ).toEqual({ status: "pending", requestId: 7 });
    expect(
      friendRequestState(
        request,
        lists({ friends: [friend("TALLY MARSH")] }),
        undefined,
      ),
    ).toEqual({ status: "accepted" });
    expect(friendRequestState(request, lists({}), undefined)).toEqual({
      status: "declined",
    });
  });

  it("lets this client's own answer outrank a list that has not refreshed", () => {
    // The seconds between the click and the refetch: still in `incoming`,
    // already answered.
    expect(
      friendRequestState(
        request,
        lists({ incoming: [{ id: 7, name: REQUESTER }] }),
        "accepted",
      ),
    ).toEqual({ status: "accepted" });
  });

  it("says nothing about other kinds, or before the lists exist", () => {
    expect(friendRequestState(entry(9), lists({}), undefined)).toEqual({
      status: "unknown",
    });
    expect(friendRequestState(request, undefined, undefined)).toEqual({
      status: "unknown",
    });
  });
});

describe("notificationLine", () => {
  it("names the conversation when the client knows it", () => {
    expect(notificationLine(entry(1), "#Frontpage")).toBe(
      "Nyx Firemane mentioned you in #Frontpage",
    );
    // A conversation this device has never synced still reads as a sentence.
    expect(notificationLine(entry(1), undefined)).toBe(
      "Nyx Firemane mentioned you",
    );
    expect(notificationLine(entry(1, { character: "" }), undefined)).toBe(
      "Someone mentioned you",
    );
  });
});
