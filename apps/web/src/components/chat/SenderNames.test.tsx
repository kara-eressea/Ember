// @vitest-environment jsdom
//
// Component-render tier (issue #321): sender-name colouring and the roll-line
// name. These lock the two fixes in #338 / #337:
//
//   * A chat sender name wears the SAME gender colour token as the member-list
//     row for the same character — one shared resolver (genderColorVar over the
//     session roster), so the two never drift.
//   * A /roll line names the roller as a plain inline sender name, not the
//     mid-sentence mention chip — no badge/chip classes around it.
//
// The name colour is an inline `var(--eb-gender-…)` token, asserted off the
// element's `style` attribute (jsdom keeps the custom-property value verbatim).

import { afterEach, describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import type { UserPrefs } from "@emberchat/protocol";
import { PREFS_DEFAULTS } from "@emberchat/protocol";
import { MemberList } from "./MemberList.js";
import { PlainNamesProvider, RichText } from "./RichText.js";
import {
  useSessionsStore,
  type ChannelView,
  type IdentitySession,
} from "../../stores/sessions.js";

const IDENTITY = "id1";
const CHAR = "Nyx Firemane";

function channel(
  members: { character: string; gender: string }[],
): ChannelView {
  return {
    convId: "c1",
    key: "adh-1",
    title: "Test Room",
    description: "",
    mode: "both",
    oplist: [],
    members: members.map((m) => ({ ...m, status: "online", statusmsg: "" })),
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

function seedSession(ch: ChannelView, prefs: UserPrefs = PREFS_DEFAULTS): void {
  const session: IdentitySession = {
    identityId: IDENTITY,
    character: "Me",
    sessionStatus: "online",
    ownStatus: "online",
    ownStatusmsg: "",
    ignores: [],
    limits: { chatMax: 4096, privMax: 50000, lfrpMax: 50000, lfrpFlood: 600 },
    iconBlacklist: [],
    chatop: false,
    sendDelaySeconds: 0,
    prefs,
    outbox: [],
    campaign: null,
    channels: { [ch.key]: ch },
    dms: {},
    channelByConvId: { [ch.convId]: ch.key },
    synced: true,
    invites: [],
    // Seeded so the list's lazy social loader short-circuits (no fetch).
    social: {
      bookmarks: [],
      friends: [],
      incoming: [],
      outgoing: [],
      fetchedAt: Date.now(),
    },
  };
  useSessionsStore.setState({ sessions: { [IDENTITY]: session } });
}

const initialSessions = useSessionsStore.getState().sessions;
afterEach(() => {
  useSessionsStore.setState({ sessions: initialSessions });
});

/** The inline colour a rendered name carries, read verbatim off `style`. */
function nameColor(el: HTMLElement): string {
  return el.style.color;
}

describe("sender name colour matches the member list (#338)", () => {
  it("a roll-line roller name carries the member-list gender colour token", () => {
    const ch = channel([{ character: CHAR, gender: "Male" }]);
    seedSession(ch);

    const list = render(
      <MemberList identityId={IDENTITY} ownCharacter="Me" channel={ch} />,
    );
    const memberName = within(list.container).getByText(CHAR);
    // Gender token (not a per-nick hash colour): --eb-gender-male.
    expect(nameColor(memberName)).toBe("var(--eb-gender-male)");
    list.unmount();

    // The roller in a roll line resolves to the same character → same token.
    render(
      <PlainNamesProvider value={{ plain: true, identityId: IDENTITY }}>
        <RichText bbcode={`[user]${CHAR}[/user] rolls 1d20: [b]13[/b]`} />
      </PlainNamesProvider>,
    );
    const rollName = screen.getByRole("button", { name: CHAR });
    expect(nameColor(rollName)).toBe("var(--eb-gender-male)");
  });

  it("an unknown gender takes no colour token — like the member list", () => {
    const ch = channel([{ character: CHAR, gender: "None" }]);
    seedSession(ch);

    const list = render(
      <MemberList identityId={IDENTITY} ownCharacter="Me" channel={ch} />,
    );
    expect(nameColor(within(list.container).getByText(CHAR))).toBe("");
    list.unmount();

    render(
      <PlainNamesProvider value={{ plain: true, identityId: IDENTITY }}>
        <RichText bbcode={`[user]${CHAR}[/user] rolls 1d20: [b]13[/b]`} />
      </PlainNamesProvider>,
    );
    expect(nameColor(screen.getByRole("button", { name: CHAR }))).toBe("");
  });
});

describe("roll-line name has no chip/badge (#337)", () => {
  it("renders the roller as a plain .nick name, not a mention chip", () => {
    seedSession(channel([{ character: CHAR, gender: "Male" }]));
    render(
      <PlainNamesProvider value={{ plain: true, identityId: IDENTITY }}>
        <RichText bbcode={`[user]${CHAR}[/user] rolls 1d20: [b]13[/b]`} />
      </PlainNamesProvider>,
    );
    const name = screen.getByRole("button", { name: CHAR });
    // No mention-chip / link-chip badge classes.
    expect(name.className).not.toMatch(/bodyMention|linkChip/);
    // It wears the shared sender-name (.nick) treatment instead.
    expect(name.className).toMatch(/nick/);
  });

  it("a [user] name OUTSIDE a roll line keeps the mention chip", () => {
    seedSession(channel([{ character: CHAR, gender: "Male" }]));
    // No PlainNamesProvider → default body treatment.
    render(<RichText bbcode={`hi [user]${CHAR}[/user]`} />);
    const name = screen.getByRole("button", { name: CHAR });
    expect(name.className).toMatch(/bodyMention/);
  });
});
