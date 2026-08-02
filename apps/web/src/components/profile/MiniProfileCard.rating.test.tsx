// @vitest-environment jsdom
//
// The mini card's "Your rating" block (M11 §9): it composes below the
// compatibility block for a rated character, stays out of the way for an
// unrated one, never appears on your own card (you can't rate yourself),
// and its Edit button is the second way into the rate editor.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import type { ProfileResponse, RatingDto } from "@emberchat/protocol";
import { MiniProfileCard } from "./MiniProfileCard.js";
import { useProfileStore } from "../../stores/profile.js";
import { useRatingsStore } from "../../stores/ratings.js";

vi.mock("../../lib/social.js", () => ({
  loadSocial: vi.fn(() => Promise.resolve()),
}));
vi.mock("../../gateway/socket.js", () => ({
  gateway: { cmd: vi.fn().mockResolvedValue({ ok: true }) },
}));
// The card's profile is seeded into the store, so nothing should reach the
// network — these stubs make that failure loud rather than silent.
vi.mock("../../lib/api.js", () => ({
  api: {
    getProfile: vi.fn().mockRejectedValue(new Error("unexpected fetch")),
    getRatings: vi.fn().mockResolvedValue({ ratings: [] }),
    putRating: vi.fn(),
    deleteRating: vi.fn(),
  },
}));

const IDENTITY = "id-1";
const ANCHOR = { top: 100, left: 40, bottom: 130, right: 140 };

function profile(name: string): ProfileResponse {
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
      infotagGroups: [],
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

const RATING: RatingDto = {
  character: "Sorrel",
  score: 4,
  note: "great scene partner",
  updatedAt: "2026-08-01T00:00:00.000Z",
};

function renderCard(name: string, ownCharacter = "Amber Vale") {
  render(
    <MemoryRouter>
      <MiniProfileCard
        identityId={IDENTITY}
        ownCharacter={ownCharacter}
        name={name}
        anchor={ANCHOR}
        onClose={vi.fn()}
      />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  useProfileStore.setState({
    profiles: {
      sorrel: { state: "ok", response: profile("Sorrel") },
      "amber vale": { state: "ok", response: profile("Amber Vale") },
    },
    ownProfile: undefined,
  });
  useRatingsStore.setState({ loaded: true, byName: { sorrel: RATING } });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("MiniProfileCard rating block (M11 §9)", () => {
  it("shows the stars, the score and the private note for a rated character", () => {
    renderCard("Sorrel");

    expect(screen.getByText("Your rating")).toBeInTheDocument();
    expect(
      screen.getByRole("img", { name: "Rated 4 of 5" }),
    ).toBeInTheDocument();
    expect(screen.getByText("4/5")).toBeInTheDocument();
    expect(screen.getByText("“great scene partner”")).toBeInTheDocument();
    // The local-only promise is repeated on every rating surface.
    expect(screen.getByText("this server only")).toBeInTheDocument();
  });

  it("renders nothing for an unrated character", () => {
    useRatingsStore.setState({ loaded: true, byName: {} });
    renderCard("Sorrel");

    expect(screen.queryByText("Your rating")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Edit" }),
    ).not.toBeInTheDocument();
  });

  it("hides the block on your own card", () => {
    useRatingsStore.setState({
      loaded: true,
      byName: { "amber vale": { ...RATING, character: "Amber Vale" } },
    });
    renderCard("Amber Vale");

    expect(screen.queryByText("Your rating")).not.toBeInTheDocument();
  });

  it("omits the note line when the rating carries none", () => {
    useRatingsStore.setState({
      loaded: true,
      byName: { sorrel: { ...RATING, note: undefined } },
    });
    renderCard("Sorrel");

    expect(screen.getByText("Your rating")).toBeInTheDocument();
    expect(screen.queryByText(/“/)).not.toBeInTheDocument();
  });

  it("opens the rate editor from Edit", async () => {
    const user = userEvent.setup();
    renderCard("Sorrel");

    await user.click(screen.getByRole("button", { name: "Edit" }));

    const editor = screen.getByRole("dialog", { name: "Rate Sorrel" });
    // Opens on the existing rating, ready to adjust or clear.
    expect(editor).toHaveTextContent("4/5");
    expect(
      screen.getByRole("button", { name: "Clear rating" }),
    ).toBeInTheDocument();
  });
});
