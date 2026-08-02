// @vitest-environment jsdom
//
// Separate chat/ad drafts across view flips (M10, spec §4): a "both"-mode
// channel's header Show selector swaps the composer between composing chat
// and composing an ad. Half-written text on either side has to survive the
// flip — losing a long ad because the user peeked at chat is the bug this
// guards.

import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PREFS_DEFAULTS } from "@emberchat/protocol";
import { Composer } from "./Composer.js";
import type { IdentitySession } from "../../stores/sessions.js";

vi.mock("../../gateway/socket.js", () => ({
  gateway: { cmd: vi.fn().mockResolvedValue({ ok: true }) },
}));

// The toolbar measures itself (#288); jsdom has no ResizeObserver.
vi.stubGlobal(
  "ResizeObserver",
  class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  },
);

const SESSION: IdentitySession = {
  identityId: "id-1",
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

function renderComposer(adView: string) {
  return render(
    <Composer
      session={SESSION}
      convId="c1"
      channelKey="Frontpage"
      channelMode="both"
      adView={adView}
      placeholder="Message #Frontpage"
      maxBytes={4096}
    />,
  );
}

const input = () => screen.getByLabelText("Message");

afterEach(() => {
  vi.clearAllMocks();
});

describe("Composer chat/ad draft stash (M10)", () => {
  it("stashes the chat draft and comes back empty in the ads view", async () => {
    const user = userEvent.setup();
    const { rerender } = renderComposer("chat");

    await user.type(input(), "half a sentence");
    rerender(
      <Composer
        session={SESSION}
        convId="c1"
        channelKey="Frontpage"
        channelMode="both"
        adView="ads"
        placeholder="Message #Frontpage"
        maxBytes={4096}
      />,
    );

    expect(input()).toHaveValue("");
  });

  it("restores each draft when the view flips back", async () => {
    const user = userEvent.setup();
    const { rerender } = renderComposer("chat");
    const flip = (adView: string) => {
      rerender(
        <Composer
          session={SESSION}
          convId="c1"
          channelKey="Frontpage"
          channelMode="both"
          adView={adView}
          placeholder="Message #Frontpage"
          maxBytes={4096}
        />,
      );
    };

    await user.type(input(), "chat draft");
    flip("ads");
    await user.type(input(), "ad draft");
    flip("chat");

    expect(input()).toHaveValue("chat draft");

    flip("ads");
    expect(input()).toHaveValue("ad draft");
  });

  it("leaves the draft alone when the view prop changes to an equivalent view", async () => {
    const user = userEvent.setup();
    const { rerender } = renderComposer("chat");

    await user.type(input(), "still here");
    // Anything that isn't "ads" is the chat view — a re-render with
    // undefined must not be read as a flip.
    rerender(
      <Composer
        session={SESSION}
        convId="c1"
        channelKey="Frontpage"
        channelMode="both"
        placeholder="Message #Frontpage"
        maxBytes={4096}
      />,
    );

    expect(input()).toHaveValue("still here");
  });
});
