// @vitest-environment jsdom
//
// #350: DmProfile renders the partner's status through RichText for the body
// but ALSO as a plain-text `title` tooltip on the status row — that tooltip
// bypasses RichText, so it must decode the server's wire entities itself.

import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { DmProfile } from "./DmProfile.js";
import { useSessionsStore, type DmView } from "../../stores/sessions.js";

// The panel mount lazily loads profiles/social; stub the loaders so no relative
// fetch escapes into jsdom. The stores stay empty (fine for this assertion).
vi.mock("../../stores/profile.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../stores/profile.js")>()),
  loadProfile: vi.fn(),
  loadOwnProfile: vi.fn(),
}));
vi.mock("../../lib/social.js", () => ({ loadSocial: vi.fn() }));

const initialSessions = useSessionsStore.getState().sessions;
afterEach(() => {
  useSessionsStore.setState({ sessions: initialSessions });
});

function dmWithStatus(statusmsg: string): DmView {
  return {
    convId: "d1",
    partner: "Wren Salloway",
    title: "Wren Salloway",
    online: true,
    status: "online",
    statusmsg,
    pinned: false,
    typing: "clear",
    unread: 0,
    highlightedAt: 0,
    lastReadMessageId: null,
    newestMessageId: null,
  };
}

describe("DmProfile status tooltip entity decode (#350)", () => {
  it("decodes the server-escaped status in the plain-text title tooltip", () => {
    render(
      <DmProfile
        identityId="id1"
        ownCharacter="Marigold Bell"
        dm={dmWithStatus("Canons &amp; Vibes")}
        onCollapse={() => {}}
      />,
    );
    // The visible status (RichText) is decoded — locate it, then confirm its
    // enclosing status row carries the decoded text as its `title` tooltip.
    const statusText = screen.getByText("Canons & Vibes");
    const row = statusText.closest("[title]");
    expect(row).not.toBeNull();
    // The DOM attribute value is the decoded string (a single ampersand),
    // never the raw "&amp;" or a double-decoded "&amp;amp;".
    expect(row).toHaveAttribute("title", "Canons & Vibes");
  });
});
