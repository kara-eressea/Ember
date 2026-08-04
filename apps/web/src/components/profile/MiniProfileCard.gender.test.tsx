// @vitest-environment jsdom
//
// The mini profile card's name colour (#493). The card used to tint the name
// from the hash-of-the-name palette, whose hues overlap the gender palette:
// a woman's card could paint her name in the blue the chat uses for men. The
// card now takes the SAME token the chat does — asserted here by rendering
// both surfaces for one character and comparing the two colours, so the fix
// cannot rot into "they happen to agree today".

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { PREFS_DEFAULTS } from "@emberchat/protocol";
import type { ProfileResponse } from "@emberchat/protocol";
import { INFOTAG_IDS } from "@emberchat/matcher";
import { MiniProfileCard } from "./MiniProfileCard.js";
import { MemberList } from "../chat/MemberList.js";
import { useProfileStore } from "../../stores/profile.js";
import { useRatingsStore } from "../../stores/ratings.js";
import {
  useSessionsStore,
  type ChannelView,
  type IdentitySession,
} from "../../stores/sessions.js";

vi.mock("../../lib/social.js", () => ({
  loadSocial: vi.fn(() => Promise.resolve()),
}));
vi.mock("../../gateway/socket.js", () => ({
  gateway: { cmd: vi.fn().mockResolvedValue({ ok: true }) },
}));
// Everything the card needs is seeded into the stores; a fetch here would mean
// the test is measuring something other than what it claims to.
vi.mock("../../lib/api.js", () => ({
  api: {
    getProfile: vi.fn().mockRejectedValue(new Error("unexpected fetch")),
    getRatings: vi.fn().mockResolvedValue({ ratings: [] }),
  },
}));

const IDENTITY = "id-1";
const HER = "Sorrel Ashgrove";
const ANCHOR = { top: 100, left: 40, bottom: 130, right: 140 };

/** A profile response whose Gender infotag is `gender` (omitted when unset). */
function profile(name: string, gender?: string): ProfileResponse {
  return {
    profile: {
      id: 1,
      name,
      description: "",
      views: 1,
      customTitle: null,
      customsFirst: false,
      createdAt: null,
      updatedAt: null,
      settings: {
        guestbook: false,
        showFriends: false,
        preventBookmarks: false,
        public: true,
      },
      badges: [],
      infotagGroups:
        gender === undefined
          ? []
          : [
              {
                group: "General details",
                tags: [
                  { id: INFOTAG_IDS.gender, label: "Gender", value: gender },
                ],
              },
            ],
      kinks: [],
      customKinks: [],
      images: [],
      inlines: {},
      timezone: null,
    },
    fetchedAt: 1_752_000_000_000,
    stale: false,
    budgetExhausted: false,
    note: null,
    timezone: null,
  };
}

function channel(
  members: { character: string; gender: string }[],
): ChannelView {
  return {
    convId: "c1",
    key: "adh-1",
    title: "Test Room",
    description: "",
    mode: "both",
    oplist: [],
    members: members.map((m) => ({ ...m, status: "online", statusmsg: "" })),
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

function seedSession(ch: ChannelView): void {
  const session: IdentitySession = {
    identityId: IDENTITY,
    character: "Amber Vale",
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
    channels: { [ch.key]: ch },
    dms: {},
    channelByConvId: { [ch.convId]: ch.key },
    synced: true,
    invites: [],
    // Seeded so the list's lazy social loader short-circuits (no fetch).
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

/** The colour the CHAT gives this character: the member-list row's own name,
 * which is the token the message log resolves for a sender too (#338). */
function chatNameColor(ch: ChannelView, name: string): string {
  const list = render(
    <MemberList identityId={IDENTITY} ownCharacter="Amber Vale" channel={ch} />,
  );
  const color = within(list.container).getByText(name).style.color;
  list.unmount();
  return color;
}

/** The colour the CARD gives this character: the header's --gender-accent,
 * which .cardName renders the name in. */
function cardNameColor(name: string): string {
  render(
    <MemoryRouter>
      <MiniProfileCard
        identityId={IDENTITY}
        ownCharacter="Amber Vale"
        name={name}
        anchor={ANCHOR}
        onClose={vi.fn()}
      />
    </MemoryRouter>,
  );
  const card = screen.getByRole("dialog", { name: `Profile card: ${name}` });
  const header = card.querySelector<HTMLElement>("[style*='--gender-accent']");
  return header?.style.getPropertyValue("--gender-accent") ?? "";
}

const initialSessions = useSessionsStore.getState().sessions;

beforeEach(() => {
  useRatingsStore.setState({ loaded: true, byName: {} });
});

afterEach(() => {
  useSessionsStore.setState({ sessions: initialSessions });
  useProfileStore.setState({ profiles: {}, ownProfile: undefined });
  vi.clearAllMocks();
});

describe("mini profile card name colour (#493)", () => {
  it("gives a Female character the same token her chat nick wears", () => {
    const ch = channel([{ character: HER, gender: "Female" }]);
    seedSession(ch);
    useProfileStore.setState({
      profiles: {
        [HER.toLowerCase()]: { state: "ok", response: profile(HER) },
      },
    });

    const chat = chatNameColor(ch, HER);
    expect(chat).toBe("var(--eb-gender-female)");
    // The point of the issue: card and chat, one token.
    expect(cardNameColor(HER)).toBe(chat);
  });

  it("never falls back to the hash-of-the-name palette", () => {
    const ch = channel([{ character: HER, gender: "Female" }]);
    seedSession(ch);
    useProfileStore.setState({
      profiles: {
        [HER.toLowerCase()]: { state: "ok", response: profile(HER) },
      },
    });

    expect(cardNameColor(HER)).not.toMatch(/--eb-nick-/u);
  });

  it("takes the gender from the profile when no channel roster knows them", () => {
    // Nobody in the room — the search result, the guestbook signer, the
    // character you looked up by name.
    const ch = channel([]);
    seedSession(ch);
    useProfileStore.setState({
      profiles: {
        [HER.toLowerCase()]: { state: "ok", response: profile(HER, "Female") },
      },
    });

    expect(cardNameColor(HER)).toBe("var(--eb-gender-female)");
  });

  it("leaves the name uncoloured for None/unknown, exactly like the chat", () => {
    const ch = channel([{ character: HER, gender: "None" }]);
    seedSession(ch);
    useProfileStore.setState({
      profiles: {
        [HER.toLowerCase()]: { state: "ok", response: profile(HER, "None") },
      },
    });

    expect(chatNameColor(ch, HER)).toBe("");
    expect(cardNameColor(HER)).toBe("");
  });

  it("prefers the roster over the profile, so the card can never contradict the log", () => {
    // The two ends of F-List disagreeing is not a case we resolve in the UI:
    // whatever the chat is painting wins, or the same name reads two ways on
    // one screen.
    const ch = channel([{ character: HER, gender: "Female" }]);
    seedSession(ch);
    useProfileStore.setState({
      profiles: {
        [HER.toLowerCase()]: { state: "ok", response: profile(HER, "Male") },
      },
    });

    expect(cardNameColor(HER)).toBe(chatNameColor(ch, HER));
  });
});
