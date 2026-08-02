// @vitest-environment jsdom
//
// The FKS dialog's two refusal-shaped behaviours: the server's error codes
// each get their own plain-language tile (a bare code would tell the user
// nothing about what to change), and the saved-search rail stops at 12 — the
// prefs document is synced, so the list is capped rather than unbounded.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PREFS_DEFAULTS } from "@emberchat/protocol";
import { CharacterSearch } from "./CharacterSearch.js";
import { useSearchStore } from "../../stores/search.js";
import type { IdentitySession } from "../../stores/sessions.js";
import type { SavedSearch } from "./search-logic.js";

vi.mock("../../gateway/socket.js", () => ({
  gateway: { cmd: vi.fn().mockResolvedValue({ ok: true }) },
}));

// Saving writes through the prefs patcher; the rail reads its list from the
// session prop, so the spy is all the assertion needs.
const patchPrefs = vi.hoisted(() => vi.fn().mockResolvedValue(true));
vi.mock("../prefs/patch.js", () => ({ patchPrefs }));

// The kink vocabulary is fetched once per app session and memoised in the
// module — one entry is enough to make a search saveable.
vi.mock("../../lib/api.js", () => ({
  api: {
    getKinks: vi.fn().mockResolvedValue({
      kinks: [{ id: "1", name: "Biting", group: "Body" }],
    }),
  },
}));

const IDENTITY = "id-1";

function saved(index: number): SavedSearch {
  return {
    id: `s${String(index)}`,
    name: `Saved ${String(index)}`,
    kinks: ["1"],
  };
}

function session(savedSearches: SavedSearch[] = []): IdentitySession {
  return {
    identityId: IDENTITY,
    character: "Amber Vale",
    sessionStatus: "online",
    ownStatus: "online",
    ownStatusmsg: "",
    ignores: [],
    invites: [],
    limits: { chatMax: 4096, privMax: 50000, lfrpMax: 50000, lfrpFlood: 600 },
    iconBlacklist: [],
    chatop: false,
    sendDelaySeconds: 0,
    prefs: { ...PREFS_DEFAULTS, savedSearches },
    outbox: [],
    campaign: null,
    channels: {},
    dms: {},
    channelByConvId: {},
    synced: true,
  };
}

function renderSearch(savedSearches?: SavedSearch[]) {
  return render(
    <CharacterSearch session={session(savedSearches)} onClose={vi.fn()} />,
  );
}

/** Puts the identity in the refused state the reply event would leave. */
function refuse(code: number, message: string) {
  useSearchStore.setState({
    byIdentity: {
      [IDENTITY]: {
        searching: false,
        lastSearchAt: 0,
        refusal: { code, message },
      },
    },
  });
}

beforeEach(() => {
  useSearchStore.setState({ byIdentity: {} });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("CharacterSearch refusal tiles", () => {
  it("explains an empty result set (FKS 18)", () => {
    refuse(18, "No results found.");
    renderSearch();

    expect(screen.getByText("No characters found")).toBeInTheDocument();
    expect(
      screen.getByText(/Loosen the optional filters or drop a kink/),
    ).toBeInTheDocument();
  });

  it("tells the user to narrow when the server caps the results (FKS 72)", () => {
    refuse(72, "Too many results, please narrow your search.");
    renderSearch();

    expect(screen.getByText("Too many results")).toBeInTheDocument();
    expect(
      screen.getByText(/add another kink or a filter to narrow it/),
    ).toBeInTheDocument();
  });

  it("distinguishes too many search terms (FKS 61) from too many results", () => {
    refuse(61, "Too many search terms.");
    renderSearch();

    expect(screen.getByText("Too many search terms")).toBeInTheDocument();
    expect(screen.queryByText("Too many results")).not.toBeInTheDocument();
  });

  it("falls back to the server's own words for any other refusal", () => {
    // Pace refusals and the client watchdog both arrive with no code we
    // recognise — the message is the only thing worth showing.
    refuse(0, "The search didn't come back — try again");
    renderSearch();

    expect(screen.getByText("Not right now")).toBeInTheDocument();
    expect(
      screen.getByText("The search didn't come back — try again"),
    ).toBeInTheDocument();
  });

  it("shows the results list instead once a search succeeds", () => {
    useSearchStore.setState({
      byIdentity: {
        [IDENTITY]: {
          searching: false,
          lastSearchAt: 0,
          results: ["Sorrel", "Nettle Fen"],
        },
      },
    });
    renderSearch();

    expect(screen.getByText("2 online")).toBeInTheDocument();
    expect(screen.queryByText("No characters found")).not.toBeInTheDocument();
  });
});

describe("CharacterSearch saved-search cap", () => {
  /** Picks the one vocabulary kink, which is what makes a search saveable. */
  async function pickAKink(user: ReturnType<typeof userEvent.setup>) {
    await user.click(
      await screen.findByRole("button", { name: "+ Add kinks…" }),
    );
    await user.click(screen.getByRole("button", { name: /Biting/ }));
    await user.click(screen.getByRole("button", { name: "Done" }));
  }

  it("saves the twelfth search", async () => {
    const user = userEvent.setup();
    const existing = Array.from({ length: 11 }, (_, index) => saved(index));
    renderSearch(existing);
    await pickAKink(user);

    await user.click(screen.getByRole("button", { name: /Save current/ }));
    await user.type(
      screen.getByLabelText("Saved search name"),
      "Twelfth{Enter}",
    );

    expect(patchPrefs).toHaveBeenCalledTimes(1);
    const [, patch] = patchPrefs.mock.calls[0] as [
      string,
      { savedSearches: SavedSearch[] },
    ];
    expect(patch.savedSearches).toHaveLength(12);
    expect(patch.savedSearches[11]?.name).toBe("Twelfth");
  });

  it("refuses a thirteenth — the button is disabled at the cap", async () => {
    const user = userEvent.setup();
    const full = Array.from({ length: 12 }, (_, index) => saved(index));
    renderSearch(full);
    await pickAKink(user);

    const save = screen.getByRole("button", { name: /Save current/ });
    expect(save).toBeDisabled();
    await user.click(save);
    // No name prompt, no write — the rail stays at twelve.
    expect(
      screen.queryByLabelText("Saved search name"),
    ).not.toBeInTheDocument();
    expect(patchPrefs).not.toHaveBeenCalled();
  });
});
