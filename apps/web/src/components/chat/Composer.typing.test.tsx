// @vitest-environment jsdom
//
// Typing indicator placement (#336): the "X is typing…" status rests on a slim
// line directly above the message box, Discord-style. These tests pin the
// plain-language copy for each TPN state, that the line only renders for DMs
// (TPN is DM-only in F-Chat), and that its height is reserved when idle so the
// message log never jumps as the status comes and goes.

import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { PREFS_DEFAULTS } from "@emberchat/protocol";
import { Composer } from "./Composer.js";
import type { DmView, IdentitySession } from "../../stores/sessions.js";

// The composer talks to the gateway on typing/send only — never on mount for
// these assertions — but stub it so nothing reaches a real socket.
vi.mock("../../gateway/socket.js", () => ({
  gateway: { cmd: vi.fn().mockResolvedValue({ ok: true }) },
}));

// The composer toolbar observes its own size (#288); jsdom has no
// ResizeObserver, so a no-op stand-in lets the tree mount.
vi.stubGlobal(
  "ResizeObserver",
  class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  },
);

function dm(typing: string): DmView {
  return {
    convId: "d1",
    partner: "Sorrel",
    title: "Sorrel",
    online: true,
    status: "online",
    statusmsg: "",
    pinned: false,
    typing,
    unread: 0,
    highlightedAt: 0,
    lastReadMessageId: null,
    newestMessageId: null,
  };
}

function session(typing: string): IdentitySession {
  return {
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
    dms: { d1: dm(typing) },
    channelByConvId: {},
    synced: true,
  };
}

function renderDm(typing: string) {
  return render(
    <Composer
      session={session(typing)}
      convId="d1"
      partner="Sorrel"
      placeholder="Message Sorrel"
      maxBytes={50000}
    />,
  );
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("composer typing line (#336)", () => {
  it("shows the partner is typing", () => {
    renderDm("typing");
    expect(screen.getByTestId("typing-line")).toHaveTextContent(
      "Sorrel is typing…",
    );
  });

  it("shows the paused state in plain language", () => {
    renderDm("paused");
    expect(screen.getByTestId("typing-line")).toHaveTextContent(
      "Sorrel has typed something",
    );
  });

  it("reserves the line but shows no text when the status is clear", () => {
    renderDm("clear");
    const line = screen.getByTestId("typing-line");
    // Present in the DOM (height reserved so the log never jumps) but empty.
    expect(line).toBeInTheDocument();
    expect(line).toHaveTextContent("");
  });

  it("does not render the line for a channel (TPN is DM-only)", () => {
    render(
      <Composer
        session={session("clear")}
        convId="c1"
        channelKey="Frontpage"
        channelMode="chat"
        placeholder="Message #Frontpage"
        maxBytes={4096}
      />,
    );
    expect(screen.queryByTestId("typing-line")).not.toBeInTheDocument();
  });
});
