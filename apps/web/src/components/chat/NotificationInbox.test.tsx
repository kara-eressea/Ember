// @vitest-environment jsdom
//
// The inbox chip and its dropdown (#466): the badge clears on open (the
// Discord model), each kind renders its own line, and a mention row hands the
// jump machinery the message it points at.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import type { NotificationDto } from "@emberchat/protocol";
import { api } from "../../lib/api.js";
import { useMessagesStore } from "../../stores/messages.js";
import { useNotificationsStore } from "../../stores/notifications.js";
import { useUiStore } from "../../stores/ui.js";
import { InboxChip, notificationLine } from "./NotificationInbox.js";

vi.mock("../../lib/api.js", () => ({
  api: {
    listNotifications: vi.fn(),
    putNotificationsSeen: vi.fn(),
  },
}));

const mocked = vi.mocked(api);
const IDENTITY = "id-1";

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
});

afterEach(() => {
  useMessagesStore.getState().reset();
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
