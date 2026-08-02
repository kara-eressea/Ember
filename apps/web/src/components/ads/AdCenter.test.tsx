// @vitest-environment jsdom
//
// The Ad Center's compare-and-set conflict flow (M10 step 5): every save is a
// full-list PUT carrying the ids the client last saw, so a library that moved
// under us comes back 409 — or arrives as another device's `ads.updated`
// before we even press Save. Both raise the same reload-and-review banner,
// and the one thing neither may ever do is throw away what was typed.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PREFS_DEFAULTS, type AdDto } from "@emberchat/protocol";
import { AdCenter } from "./AdCenter.js";
import { ApiError } from "../../lib/api.js";
import { useAdsStore } from "../../stores/ads.js";
import type { IdentitySession } from "../../stores/sessions.js";

const { getAds, putAds } = vi.hoisted(() => ({
  getAds: vi.fn(),
  putAds: vi.fn(),
}));
// Only the api object is faked — ApiError stays the real class, which is what
// the 409 branch narrows on.
vi.mock("../../lib/api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/api.js")>()),
  api: { getAds, putAds },
}));

const IDENTITY = "id-1";

const AD: AdDto = {
  id: "ad-1",
  content: "Looking for a slow burn",
  tags: ["slow"],
  disabled: false,
};

/** What another device wrote — same slot, different id and text. */
const THEIRS: AdDto = {
  id: "ad-2",
  content: "Rewritten on the phone",
  tags: [],
  disabled: false,
};

const SESSION: IdentitySession = {
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
  prefs: PREFS_DEFAULTS,
  outbox: [],
  campaign: null,
  channels: {},
  dms: {},
  channelByConvId: {},
  synced: true,
};

const conflictBanner = () =>
  screen.queryByText("Your ads changed on another device");
const adText = () => screen.getByRole("textbox", { name: "Ad text" });
const saveButton = () => screen.getByRole("button", { name: "Save ad" });

/** Opens the one library row and appends to its text. */
async function editTheAd(user: ReturnType<typeof userEvent.setup>) {
  await user.click(
    screen.getByRole("button", { name: /Edit ad: Looking for a slow burn/ }),
  );
  await user.type(adText(), " by the fire");
}

beforeEach(() => {
  useAdsStore.setState({
    byIdentity: { [IDENTITY]: { ads: [AD], loaded: true } },
    cooldownsByIdentity: {},
  });
  getAds.mockResolvedValue({ ads: [AD] });
  putAds.mockResolvedValue({ ads: [AD] });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("AdCenter conflict banner (M10)", () => {
  it("raises the banner on a 409 and keeps the draft that caused it", async () => {
    const user = userEvent.setup();
    putAds.mockRejectedValue(new ApiError(409, "knownIds no longer match"));
    render(<AdCenter session={SESSION} onClose={vi.fn()} />);

    await editTheAd(user);
    await user.click(saveButton());

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Your ads changed on another device",
    );
    // The words that matter: nothing typed is lost, and there is a way out.
    expect(screen.getByRole("button", { name: "Reload" })).toBeInTheDocument();
    expect(adText()).toHaveValue("Looking for a slow burn by the fire");
    // Saving again over a library we no longer understand is exactly the
    // duplicate-writing bug the compare-and-set exists to stop.
    expect(saveButton()).toBeDisabled();
  });

  it("raises the same banner when another device's fan-out lands mid-edit", async () => {
    const user = userEvent.setup();
    render(<AdCenter session={SESSION} onClose={vi.fn()} />);

    await editTheAd(user);
    expect(conflictBanner()).not.toBeInTheDocument();

    // `ads.updated` from the other device — no save attempted here at all.
    act(() => {
      useAdsStore.getState().applyAds(IDENTITY, [THEIRS]);
    });

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Your ads changed on another device",
    );
    expect(saveButton()).toBeDisabled();
    expect(putAds).not.toHaveBeenCalled();
  });

  it("clears the banner on Reload, showing the current library and keeping the draft as a new ad", async () => {
    const user = userEvent.setup();
    putAds.mockRejectedValue(new ApiError(409, "knownIds no longer match"));
    getAds.mockResolvedValue({ ads: [THEIRS] });
    render(<AdCenter session={SESSION} onClose={vi.fn()} />);

    await editTheAd(user);
    await user.click(saveButton());
    await screen.findByRole("alert");

    await user.click(screen.getByRole("button", { name: "Reload" }));

    await waitFor(() => {
      expect(conflictBanner()).not.toBeInTheDocument();
    });
    // The reloaded library is what the other device wrote…
    expect(
      screen.getByRole("button", { name: /Edit ad: Rewritten on the phone/ }),
    ).toBeInTheDocument();
    // …and the draft survives, re-aimed at a row that can't overwrite anyone.
    expect(screen.getByRole("heading", { name: "New ad" })).toBeInTheDocument();
    expect(adText()).toHaveValue("Looking for a slow burn by the fire");
    expect(saveButton()).toBeEnabled();
  });

  it("saves without a banner when the library hasn't moved", async () => {
    const user = userEvent.setup();
    const saved: AdDto = {
      ...AD,
      content: "Looking for a slow burn by the fire",
    };
    putAds.mockResolvedValue({ ads: [saved] });
    render(<AdCenter session={SESSION} onClose={vi.fn()} />);

    await editTheAd(user);
    await user.click(saveButton());

    expect(await screen.findByText("Saved")).toBeInTheDocument();
    expect(conflictBanner()).not.toBeInTheDocument();
    // One full-list PUT, carrying the edit and the ids it was based on.
    expect(putAds).toHaveBeenCalledTimes(1);
    expect(putAds).toHaveBeenCalledWith(
      IDENTITY,
      [
        {
          content: "Looking for a slow burn by the fire",
          tags: ["slow"],
          disabled: false,
        },
      ],
      ["ad-1"],
    );
  });
});
