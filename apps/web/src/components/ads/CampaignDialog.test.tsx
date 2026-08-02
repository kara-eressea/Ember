// @vitest-environment jsdom
//
// The expiry bar is the campaign surface's headline strip (M11,
// COMPONENTS-rotation-ratings.md §3). campaignPhase() is unit-tested next
// door; these pin what each phase actually says — the detached hold has to
// read as a pause that resumes by itself with the hour still running, and an
// ended run has to stop offering a countdown and offer a restart instead.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AdDto, CampaignDto } from "@emberchat/protocol";
import { PREFS_DEFAULTS } from "@emberchat/protocol";
import { CampaignDialog } from "./CampaignDialog.js";
import { useAdsStore } from "../../stores/ads.js";
import type { ChannelView, IdentitySession } from "../../stores/sessions.js";

const cmd = vi.hoisted(() => vi.fn());
vi.mock("../../gateway/socket.js", () => ({ gateway: { cmd } }));
vi.mock("../../lib/api.js", () => ({
  api: { getAds: vi.fn().mockResolvedValue({ ads: [] }) },
}));

const IDENTITY = "id-1";
const MINUTE = 60_000;

function channel(key: string, title: string): ChannelView {
  return {
    convId: `conv-${key}`,
    key,
    title,
    description: "",
    mode: "ads",
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

function session(campaign: CampaignDto): IdentitySession {
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
    prefs: PREFS_DEFAULTS,
    outbox: [],
    campaign,
    channels: { "ADH-a": channel("ADH-a", "Amber Room") },
    dms: {},
    channelByConvId: {},
    synced: true,
  };
}

/** A campaign that started 20 minutes ago, with one rotating channel. */
function campaign(over: Partial<CampaignDto> = {}): CampaignDto {
  const now = Date.now();
  return {
    id: "c-1",
    tags: ["slow"],
    startedAt: now - 20 * MINUTE,
    expiresAt: now + 40 * MINUTE,
    attached: true,
    channels: [
      { key: "ADH-a", state: "active", nextAt: now + 5 * MINUTE, posts: 3 },
    ],
    ...over,
  };
}

const renderDialog = (dto: CampaignDto) =>
  render(<CampaignDialog session={session(dto)} onClose={vi.fn()} />);

beforeEach(() => {
  cmd.mockResolvedValue({ ok: true });
  useAdsStore.setState({
    byIdentity: { [IDENTITY]: { ads: [], loaded: true } },
    cooldownsByIdentity: {},
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("CampaignDialog expiry bar — detached hold", () => {
  const detached = () =>
    campaign({
      attached: false,
      channels: [{ key: "ADH-a", state: "waiting", posts: 3 }],
    });

  it("reads as a pause that resumes on its own, with the hour still running", () => {
    renderDialog(detached());

    expect(screen.getByText("Paused — no device attached")).toBeInTheDocument();
    expect(
      screen.getByText(/Rotation resumes on its own when you reconnect/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/The 1-hour clock keeps running/),
    ).toBeInTheDocument();
    // Still a running campaign: countdown and Renew, not "Start again".
    expect(screen.getByText(/^expires in \d+:\d{2}$/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "↻ Renew" })).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Start again" }),
    ).not.toBeInTheDocument();
  });

  it("announces the phase alone, without the ticking countdown", () => {
    renderDialog(detached());

    // The live region carries only the phase sentence (audit HIGH) — a
    // countdown inside it would re-announce the strip every second.
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("Campaign paused — no device attached");
    expect(status).not.toHaveTextContent("expires in");
  });

  it("holds every channel row while detached", () => {
    renderDialog(detached());

    expect(screen.getByText("held")).toBeInTheDocument();
    expect(screen.getByText(/paused while you're away/)).toBeInTheDocument();
  });
});

describe("CampaignDialog expiry bar — expired", () => {
  const expired = () =>
    campaign({
      startedAt: Date.now() - 90 * MINUTE,
      expiresAt: Date.now() - 30 * MINUTE,
    });

  it("says posting has stopped and offers a restart instead of a countdown", () => {
    renderDialog(expired());

    expect(
      screen.getByText("Campaign expired — posting has stopped"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Start again" }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/expires in/)).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "↻ Renew" }),
    ).not.toBeInTheDocument();
  });

  it("summarises the run window as the full hour", () => {
    renderDialog(expired());

    expect(screen.getByRole("status")).toHaveTextContent("Campaign expired");
    expect(screen.getByText(/^ran .+ – .+ · 1 hour$/)).toBeInTheDocument();
    // The run summary replaces the schedule view.
    expect(screen.getByText("3 posts across 1 channel")).toBeInTheDocument();
  });

  it("keeps an explicit stop distinct from a timed-out run", () => {
    renderDialog(
      campaign({
        stoppedAt: Date.now() - MINUTE,
        expiresAt: Date.now() + MINUTE,
      }),
    );

    expect(
      screen.getByText("Campaign stopped — posting has stopped"),
    ).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Campaign stopped");
    // Only an expiry earns the "· 1 hour" tail.
    expect(screen.queryByText(/· 1 hour/)).not.toBeInTheDocument();
  });
});

// One identity runs at most one campaign, so setting a second one up has to
// end in a REPLACE — never a duplicate. The setup surface is reachable with a
// live campaign the way it happens in practice: Change tags off a finished
// run, and then the run comes back under you (another device renewed or
// started one) while you are still picking.
describe("CampaignDialog replace flow", () => {
  const AD: AdDto = {
    id: "ad-1",
    content: "Looking for a slow burn",
    tags: ["slow"],
    disabled: false,
  };

  const stopped = () => campaign({ stoppedAt: Date.now() - MINUTE });

  /** Renders a finished run and takes Change tags into setup. */
  async function changeTags(user: ReturnType<typeof userEvent.setup>) {
    const view = render(
      <CampaignDialog session={session(stopped())} onClose={vi.fn()} />,
    );
    await user.click(screen.getByRole("button", { name: "Change tags" }));
    expect(
      screen.getByRole("dialog", { name: "Set up a campaign" }),
    ).toBeInTheDocument();
    // The finished run's tags and still-joined channels come along.
    expect(screen.getByRole("button", { name: /slow/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: /Amber Room/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    return view;
  }

  beforeEach(() => {
    useAdsStore.setState({
      byIdentity: { [IDENTITY]: { ads: [AD], loaded: true } },
      cooldownsByIdentity: {},
    });
  });

  it("warns that a running campaign would be replaced, and replaces it on confirm", async () => {
    const user = userEvent.setup();
    const { rerender } = await changeTags(user);

    // The run comes back while setup is open.
    rerender(
      <CampaignDialog session={session(campaign())} onClose={vi.fn()} />,
    );

    const banner = screen.getByRole("alert");
    expect(banner).toHaveTextContent(
      "A campaign is already running as Amber Vale",
    );
    expect(banner).toHaveTextContent("Starting a new one replaces it");
    // The plain Start is closed off while one runs — replacing is the only
    // way forward, so there is no path to two campaigns.
    expect(
      screen.getByRole("button", { name: "Start campaign" }),
    ).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "Replace" }));

    expect(cmd).toHaveBeenCalledTimes(1);
    expect(cmd).toHaveBeenCalledWith({
      identityId: IDENTITY,
      action: "campaign.start",
      d: { tags: ["slow"], channels: ["ADH-a"], replace: true },
    });
    // Confirmed → back to watching the (new) run.
    expect(
      await screen.findByRole("dialog", { name: "Campaign" }),
    ).toBeInTheDocument();
  });

  it("keeps the running campaign when the warning is declined", async () => {
    const user = userEvent.setup();
    const { rerender } = await changeTags(user);
    rerender(
      <CampaignDialog session={session(campaign())} onClose={vi.fn()} />,
    );

    await user.click(screen.getByRole("button", { name: "Keep current" }));

    expect(
      screen.getByRole("dialog", { name: "Campaign" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Posting live")).toBeInTheDocument();
    expect(cmd).not.toHaveBeenCalled();
  });
});
