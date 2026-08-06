// @vitest-environment jsdom
//
// The ★ rate editor on an ad row (#560). Two things the row owes it:
//
// - the trigger element, not just the rect it measured at click time — the log
//   auto-scrolls behind the editor (#284), so a frozen rect leaves it pointing
//   at whatever message has taken the row's place;
// - a row that is still there while it is open. Rating a poster 1★ collapses
//   their ad to a stub (§8), which unmounts the very button the editor is
//   anchored to — mid-sentence, in a note field the user is typing into.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { MessageDto, RatingDto } from "@emberchat/protocol";
import { PREFS_DEFAULTS } from "@emberchat/protocol";
import { MessageLog } from "./MessageLog.js";
import { useMessagesStore } from "../../stores/messages.js";
import { useRatingsStore } from "../../stores/ratings.js";
import {
  useSessionsStore,
  type ChannelView,
  type IdentitySession,
} from "../../stores/sessions.js";

const putRating = vi.hoisted(() => vi.fn());
vi.mock("../../lib/api.js", () => ({
  api: {
    putRating,
    deleteRating: vi.fn(),
    getRatings: vi.fn().mockResolvedValue({ ratings: [] }),
  },
}));

class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
globalThis.ResizeObserver = ResizeObserverStub;

// jsdom lays nothing out, so a zero-height viewport renders no rows at all.
Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
  configurable: true,
  value: 600,
});

const IDENTITY = "id1";
const CONV = "c1";
const KEY = "adh-1";
const POSTER = "Sorrel";

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

function seedAd(): void {
  const ad: MessageDto = {
    id: 1,
    senderCharacter: POSTER,
    kind: "lrp",
    bbcode: "looking for a scene",
    sentByUs: false,
    mention: false,
    createdAt: new Date("2026-08-04T12:04:33Z").toISOString(),
  };
  useMessagesStore.setState({
    buffers: {
      [CONV]: {
        messages: [ad],
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

async function renderLog(): Promise<void> {
  seedSession();
  seedAd();
  render(
    <MessageLog
      identityId={IDENTITY}
      convId={CONV}
      readCursorAtAttach={null}
    />,
  );
  // The log paints a skeleton over hidden rows until the first measurement
  // pass settles (MEASURE_REVEAL_MAX_FRAMES), and hidden rows are not in the
  // accessibility tree — so the ★ affordance is not reachable until then.
  await waitFor(async () => {
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });
    expect(
      screen.getByRole("button", { name: `Rate ${POSTER}` }),
    ).toBeInTheDocument();
  });
}

const initialSessions = useSessionsStore.getState().sessions;

beforeEach(() => {
  useRatingsStore.setState({ loaded: true, byName: {} });
  putRating.mockImplementation(
    (character: string, score: number, note?: string) =>
      Promise.resolve({
        rating: {
          character,
          score,
          note,
          updatedAt: "2026-08-04T12:00:00.000Z",
        } satisfies RatingDto,
      }),
  );
});

afterEach(() => {
  useSessionsStore.setState({ sessions: initialSessions });
  useMessagesStore.getState().reset();
  vi.clearAllMocks();
});

describe("the ad row's rate editor (#560)", () => {
  it("keeps the ad open while the editor is, then collapses on close", async () => {
    const user = userEvent.setup();
    await renderLog();

    await user.click(screen.getByRole("button", { name: `Rate ${POSTER}` }));
    const editor = screen.getByRole("dialog", { name: `Rate ${POSTER}` });

    // One star: low enough that the row would otherwise collapse to a stub
    // and take the editor's own trigger — and the note field — with it.
    await user.click(screen.getByRole("radio", { name: "1 star" }));
    expect(useRatingsStore.getState().byName["sorrel"]?.score).toBe(1);
    expect(editor).toBeInTheDocument();
    expect(screen.getByLabelText("Private note")).toBeInTheDocument();
    expect(screen.queryByText(/ad hidden/)).not.toBeInTheDocument();

    // Escape closes the editor; the rating the user just gave then applies.
    await user.keyboard("{Escape}");
    expect(
      screen.queryByRole("dialog", { name: `Rate ${POSTER}` }),
    ).not.toBeInTheDocument();
    expect(screen.getByText(/ad hidden/)).toBeInTheDocument();
  });

  it("hands the editor the trigger element, not just its rect", async () => {
    const user = userEvent.setup();
    await renderLog();

    const pill = screen.getByRole("button", { name: `Rate ${POSTER}` });
    // The row is what moves under the editor, so the editor has to be able to
    // ask the button where it is now. Removing it is what the virtualizer
    // does at the far end of a scroll — the editor closes rather than float
    // at coordinates that no longer mean anything.
    await user.click(pill);
    expect(
      screen.getByRole("dialog", { name: `Rate ${POSTER}` }),
    ).toBeInTheDocument();

    pill.remove();
    await act(async () => {
      window.dispatchEvent(new Event("scroll"));
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });

    expect(
      screen.queryByRole("dialog", { name: `Rate ${POSTER}` }),
    ).not.toBeInTheDocument();
  });
});
