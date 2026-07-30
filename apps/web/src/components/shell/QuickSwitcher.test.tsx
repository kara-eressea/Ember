// @vitest-environment jsdom
//
// #389: arrowing through the quick-switcher must keep the highlighted row in
// view — the selection change fires scrollIntoView({ block: "nearest" }) so a
// row past the scroll fold is pulled onto screen.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { PREFS_DEFAULTS } from "@emberchat/protocol";
import { QuickSwitcher } from "./QuickSwitcher.js";
import type { DmView, IdentitySession } from "../../stores/sessions.js";

function dm(partner: string): DmView {
  return {
    convId: partner,
    partner,
    title: partner,
    online: true,
    status: "online",
    statusmsg: "",
    pinned: false,
    typing: "clear",
    unread: 0,
    highlightedAt: 0,
    lastReadMessageId: null,
    newestMessageId: null,
  };
}

function session(): IdentitySession {
  const dms: Record<string, DmView> = {};
  for (const name of ["Ana", "Bea", "Cy", "Dot", "Eve", "Fern"]) {
    dms[name] = dm(name);
  }
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
    dms,
    channelByConvId: {},
    synced: true,
  };
}

let scrollSpy: ReturnType<typeof vi.fn<(arg?: ScrollIntoViewOptions) => void>>;

beforeEach(() => {
  scrollSpy = vi.fn<(arg?: ScrollIntoViewOptions) => void>();
  // jsdom does not implement scrollIntoView — install a spy on the prototype.
  Element.prototype.scrollIntoView = scrollSpy;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("QuickSwitcher selection scrolling", () => {
  it("scrolls the newly selected row into view with block:nearest", () => {
    render(
      <MemoryRouter>
        <QuickSwitcher
          session={session()}
          identities={[{ id: "id-1", name: "Amber Vale" }]}
          onClose={() => undefined}
        />
      </MemoryRouter>,
    );

    const input = screen.getByRole("combobox");
    scrollSpy.mockClear();
    fireEvent.keyDown(input, { key: "ArrowDown" });

    expect(scrollSpy).toHaveBeenCalledWith({ block: "nearest" });
    // The DMs sort ahead of everything; ArrowDown moves to the second one.
    expect(input.getAttribute("aria-activedescendant")).toBe("qs-Bea");
  });
});
