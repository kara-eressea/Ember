// @vitest-environment jsdom
//
// Post Ads posts one channel at a time and nothing retries on its own (M10
// step 6): a run where some channels refuse has to end in a truthful partial
// summary, and "Retry N failed" must re-attempt ONLY the refused channels —
// re-posting a channel that already took the ad would earn a cooldown
// refusal at best.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PREFS_DEFAULTS, type AdDto } from "@emberchat/protocol";
import { PostAdsDialog } from "./PostAdsDialog.js";
import { useAdsStore } from "../../stores/ads.js";
import type { ChannelView, IdentitySession } from "../../stores/sessions.js";

const cmd = vi.hoisted(() => vi.fn());
vi.mock("../../gateway/socket.js", () => ({ gateway: { cmd } }));

// The library is already in the store for these runs; the dialog only
// fetches when it isn't loaded.
vi.mock("../../lib/api.js", () => ({
  api: { getAds: vi.fn().mockResolvedValue({ ads: [] }) },
}));

const IDENTITY = "id-1";

const AD: AdDto = {
  id: "ad-1",
  content: "Looking for a slow burn\nsecond line",
  tags: ["slow"],
  disabled: false,
};

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
  channels: {
    "ADH-a": channel("ADH-a", "Amber Room"),
    "ADH-b": channel("ADH-b", "Briar Room"),
  },
  dms: {},
  channelByConvId: {},
  synced: true,
};

interface CmdMessage {
  action: string;
  d?: { convId?: string };
}

/** Acks msg.send per channel from `outcomes`; everything else succeeds. */
function ackBy(outcomes: Record<string, { ok: boolean; error?: string }>) {
  cmd.mockImplementation((message: CmdMessage) => {
    if (message.action !== "msg.send") {
      return Promise.resolve({ ok: true });
    }
    const key = message.d?.convId?.replace("conv-", "") ?? "";
    return Promise.resolve(outcomes[key] ?? { ok: true });
  });
}

/** Picks the ad, selects every eligible channel, posts. */
async function postAll(user: ReturnType<typeof userEvent.setup>) {
  await user.click(
    screen.getByRole("radio", { name: /Looking for a slow burn/ }),
  );
  await user.click(
    screen.getByRole("checkbox", { name: /Select all eligible/ }),
  );
  await user.click(screen.getByRole("button", { name: "Post now" }));
}

const sendCalls = (): CmdMessage[] =>
  (cmd.mock.calls as [CmdMessage][])
    .map(([message]) => message)
    .filter((message) => message.action === "msg.send");

beforeEach(() => {
  useAdsStore.setState({
    byIdentity: { [IDENTITY]: { ads: [AD], loaded: true } },
    cooldownsByIdentity: {},
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("PostAdsDialog partial failure (M10)", () => {
  it("reports the partial count and the server's reason per channel", async () => {
    const user = userEvent.setup();
    ackBy({
      "ADH-b": { ok: false, error: "You must wait, next available in 4m" },
    });
    render(<PostAdsDialog session={SESSION} onClose={vi.fn()} />);

    await postAll(user);

    expect(await screen.findByRole("status")).toHaveTextContent(
      "Posted to 1 of 2 channels",
    );
    expect(screen.getByRole("status")).toHaveTextContent("1 sent · 1 refused");
    // The cooldown refusal is already written for people — passed through.
    expect(
      screen.getByText("You must wait, next available in 4m"),
    ).toBeInTheDocument();
  });

  it("retries only the refused channels, then folds the result into the summary", async () => {
    const user = userEvent.setup();
    ackBy({ "ADH-b": { ok: false, error: "boom" } });
    render(<PostAdsDialog session={SESSION} onClose={vi.fn()} />);

    await postAll(user);
    expect(sendCalls()).toHaveLength(2);

    ackBy({});
    await user.click(
      await screen.findByRole("button", { name: "Retry 1 failed" }),
    );

    // Exactly one more send, and only for the channel that refused.
    const retried = sendCalls().slice(2);
    expect(retried).toHaveLength(1);
    expect(retried[0]?.d?.convId).toBe("conv-ADH-b");
    // Both rows now read as sent — the retry replaces the failed outcome
    // rather than appending a second row for the same channel.
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Posted to 2 of 2 channels",
    );
    expect(
      screen.queryByRole("button", { name: /Retry/ }),
    ).not.toBeInTheDocument();
  });

  it("translates an opaque server error into plain language", async () => {
    const user = userEvent.setup();
    ackBy({
      "ADH-a": { ok: false, error: "ERR_LRP_INTERNAL_7" },
      "ADH-b": { ok: false, error: "identity is not online" },
    });
    render(<PostAdsDialog session={SESSION} onClose={vi.fn()} />);

    await postAll(user);

    expect(await screen.findByRole("status")).toHaveTextContent(
      "Posted to 0 of 2 channels",
    );
    expect(screen.getByText("The server refused this ad")).toBeInTheDocument();
    expect(
      screen.getByText("This character isn't connected right now"),
    ).toBeInTheDocument();
    expect(screen.queryByText("ERR_LRP_INTERNAL_7")).not.toBeInTheDocument();
  });

  it("says nothing about refusals when every channel took the ad", async () => {
    const user = userEvent.setup();
    ackBy({});
    render(<PostAdsDialog session={SESSION} onClose={vi.fn()} />);

    await postAll(user);

    const summary = await screen.findByRole("status");
    expect(summary).toHaveTextContent("Posted to 2 of 2 channels");
    expect(within(summary).queryByText(/refused/)).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Retry/ }),
    ).not.toBeInTheDocument();
  });
});
