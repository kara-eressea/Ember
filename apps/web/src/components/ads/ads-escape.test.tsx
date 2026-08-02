// @vitest-environment jsdom
//
// Escape layering across the ad surfaces (WP-7). The Ad Center and the Post
// ads dialog are siblings in the shell and are routinely open together — with
// hand-rolled bubble-phase listeners one press ran BOTH handlers, so
// dismissing the small dialog also discarded (or armed the discard warning
// on) the Ad Center behind it. Both now register on the shared Escape stack,
// which hands the key to the topmost overlay only.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PREFS_DEFAULTS, type AdDto } from "@emberchat/protocol";
import { AdCenter } from "./AdCenter.js";
import { PostAdsDialog } from "./PostAdsDialog.js";
import { useAdsStore } from "../../stores/ads.js";
import type { IdentitySession } from "../../stores/sessions.js";

const { getAds, putAds } = vi.hoisted(() => ({
  getAds: vi.fn(),
  putAds: vi.fn(),
}));
vi.mock("../../lib/api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/api.js")>()),
  api: { getAds, putAds },
}));
vi.mock("../../gateway/socket.js", () => ({
  gateway: { cmd: vi.fn().mockResolvedValue({ ok: true }) },
}));

const IDENTITY = "id-1";

const AD: AdDto = {
  id: "ad-1",
  content: "Looking for a slow burn",
  tags: ["slow"],
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

const discardWarning = () =>
  screen.queryByText(/press Escape again to discard/);

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

describe("Escape over stacked ad surfaces", () => {
  it("closes only the dialog on top, leaving the Ad Center's draft alone", async () => {
    const user = userEvent.setup();
    const closeCenter = vi.fn();
    const closeDialog = vi.fn();
    const view = render(
      <>
        <AdCenter session={SESSION} onClose={closeCenter} />
        <PostAdsDialog session={SESSION} onClose={closeDialog} />
      </>,
    );

    // A dirty Ad Center draft underneath: the surface that has the most to
    // lose if a stray Escape reaches it.
    await user.click(
      screen.getByRole("button", { name: /Edit ad: Looking for a slow burn/ }),
    );
    await user.type(
      screen.getByRole("textbox", { name: "Ad text" }),
      " by the fire",
    );

    await user.keyboard("{Escape}");

    expect(closeDialog).toHaveBeenCalledTimes(1);
    expect(closeCenter).not.toHaveBeenCalled();
    // Not even the first-press warning: the Ad Center's handler never ran.
    expect(discardWarning()).not.toBeInTheDocument();

    // With the dialog gone the Ad Center owns the key again — and its
    // two-press discard guard still stands.
    view.rerender(<AdCenter session={SESSION} onClose={closeCenter} />);
    await user.keyboard("{Escape}");
    expect(discardWarning()).toBeInTheDocument();
    expect(closeCenter).not.toHaveBeenCalled();

    await user.keyboard("{Escape}");
    expect(closeCenter).toHaveBeenCalledTimes(1);
  });
});
