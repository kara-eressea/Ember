// @vitest-environment jsdom
//
// Component-render tier (issue #268): RichText is the one BBCode → DOM path
// for message bodies, statuses and profile text, and until now had only
// pure-token coverage (rich-text.test.ts). These tests exercise the rendered
// output: the spoiler cover toggles, an f-list.net/c/ link is intercepted
// into the in-app profile viewer, a mini-profile status renders tags as DOM
// (not literal bracket text), and the autolink chip lays its children out in
// the label → glyph → domain order the design pins.

import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RichText, ProfileLinkProvider } from "./RichText.js";
import { useSessionsStore } from "../../stores/sessions.js";

const initialSessions = useSessionsStore.getState().sessions;
afterEach(() => {
  // useUserPrefs falls back to PREFS_DEFAULTS with no synced session; keep the
  // store clean between tests in case one seeds a session.
  useSessionsStore.setState({ sessions: initialSessions });
});

describe("RichText spoiler (#205)", () => {
  it("reveals covered text on click and re-covers on a second click", async () => {
    const user = userEvent.setup();
    render(<RichText bbcode="a ||secret|| b" />);

    // The accessible name derives from the covered text (name-from-contents),
    // so the covered/revealed hint lives on `title`.
    const spoiler = screen.getByRole("button");
    expect(spoiler).toHaveAttribute("aria-pressed", "false");
    expect(spoiler).toHaveAttribute("title", "Show spoiler");
    // The covered text is present in the DOM the whole time — the cover is a
    // visual treatment, not a content gate.
    expect(spoiler).toHaveTextContent("secret");

    await user.click(spoiler);
    expect(spoiler).toHaveAttribute("aria-pressed", "true");
    expect(spoiler).toHaveAttribute("title", "Hide spoiler");

    await user.click(spoiler);
    expect(spoiler).toHaveAttribute("aria-pressed", "false");
  });

  it("toggles on keyboard activation", async () => {
    const user = userEvent.setup();
    render(<RichText bbcode="||hidden||" />);
    const spoiler = screen.getByRole("button");
    spoiler.focus();
    await user.keyboard("{Enter}");
    expect(spoiler).toHaveAttribute("aria-pressed", "true");
    await user.keyboard(" ");
    expect(spoiler).toHaveAttribute("aria-pressed", "false");
  });
});

describe("RichText f-list.net/c/ interception (#214)", () => {
  it("a plain click opens the in-app profile viewer instead of navigating", async () => {
    const user = userEvent.setup();
    const openProfile = vi.fn();
    render(
      <ProfileLinkProvider value={openProfile}>
        <RichText bbcode="[url=https://www.f-list.net/c/Nyx%20Firemane]Nyx[/url]" />
      </ProfileLinkProvider>,
    );

    const link = screen.getByRole("link", { name: /Nyx/ });
    await user.click(link);

    expect(openProfile).toHaveBeenCalledTimes(1);
    // The decoded name (spaces, not %20) is what the viewer opens.
    expect(openProfile.mock.calls[0]?.[1]).toBe("Nyx Firemane");
  });

  it("a modified (ctrl) click falls through to the URL, not the viewer", async () => {
    const user = userEvent.setup();
    const openProfile = vi.fn();
    render(
      <ProfileLinkProvider value={openProfile}>
        <RichText bbcode="[url=https://www.f-list.net/c/Nyx]Nyx[/url]" />
      </ProfileLinkProvider>,
    );
    const link = screen.getByRole("link", { name: /Nyx/ });
    await user.keyboard("{Control>}");
    await user.click(link);
    await user.keyboard("{/Control}");
    expect(openProfile).not.toHaveBeenCalled();
  });

  it("a non-character link is left untouched", async () => {
    const user = userEvent.setup();
    const openProfile = vi.fn();
    render(
      <ProfileLinkProvider value={openProfile}>
        <RichText bbcode="[url=https://example.com/page]site[/url]" />
      </ProfileLinkProvider>,
    );
    await user.click(screen.getByRole("link", { name: /site/ }));
    expect(openProfile).not.toHaveBeenCalled();
  });
});

describe("RichText mini-profile status render (#210)", () => {
  // The mini profile card feeds STA status text straight through RichText, so
  // tags must resolve to DOM — never surface as literal bracket text.
  it("renders a [url] status as a link chip, not raw tag text", () => {
    const { container } = render(
      <RichText bbcode="Read [url=https://f-list.net]my ad[/url]!" />,
    );
    expect(screen.getByRole("link", { name: /my ad/ })).toBeInTheDocument();
    expect(container.textContent).not.toContain("[url");
  });

  it("renders [color] and [eicon] status tags as elements", () => {
    const { container } = render(
      <RichText bbcode="[color=red]mood[/color] [eicon]sparkle[/eicon]" />,
    );
    expect(container.textContent).not.toContain("[color");
    expect(container.textContent).not.toContain("[eicon");
    // The eicon (default inline display) renders an <img>.
    expect(container.querySelector("img")).toBeInTheDocument();
  });
});

describe("RichText server-entity decode (#335 follow-up)", () => {
  // NB: the bbcode is passed as a JS string expression ({"…&amp;…"}), not a
  // JSX string attribute — JSX would itself decode entities in a "…" literal
  // and rob the test of its point. The strings below carry literal entities.
  it("renders a server-escaped ampersand as a single '&'", () => {
    const { container } = render(<RichText bbcode={"Tom &amp; Jerry"} />);
    expect(container.textContent).toBe("Tom & Jerry");
  });

  it("gives a [url=] chip an href with the query intact (no &amp;)", () => {
    render(
      <RichText
        bbcode={
          "[url=https://pbs.twimg.com/media/AbC123?format=jpg&amp;name=large]pic[/url]"
        }
      />,
    );
    const link = screen.getByRole("link", { name: /pic/ });
    expect(link).toHaveAttribute(
      "href",
      "https://pbs.twimg.com/media/AbC123?format=jpg&name=large",
    );
  });

  it("decodes entities sitting adjacent to eicon/user tags", () => {
    const { container } = render(
      <RichText
        bbcode={"&lt;3 [eicon]spark[/eicon] &amp; [user]Nyx[/user]&gt;"}
      />,
    );
    // Entities decode; tags still resolve to elements (not literal brackets).
    expect(container.textContent).toContain("<3");
    expect(container.textContent).toContain("&"); // the standalone "&"
    expect(container.textContent).toContain(">");
    expect(container.textContent).not.toContain("&amp;");
    expect(container.textContent).not.toContain("[eicon");
    expect(container.querySelector("img")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Nyx" })).toBeInTheDocument();
  });

  it("does NOT decode locally composed preview text (local prop)", () => {
    // Composer/ad previews render pre-wire text, never server-escaped: a
    // literal "&amp;" the user typed must survive verbatim.
    const { container } = render(
      <RichText bbcode={"Tom &amp; Jerry"} local />,
    );
    expect(container.textContent).toBe("Tom &amp; Jerry");
  });
});

describe("RichText autolink chip child order", () => {
  // COMPONENTS-link-preview-eicon.md §1: label → glyph → domain, in that DOM
  // order. An autolinked plain URL derives its label and shows the mono host
  // suffix, so the full text pins the ordering.
  it("lays out label, glyph, then [host] for a non-previewable link", () => {
    render(<RichText bbcode="see https://example.com/page now" />);
    const link = screen.getByRole("link");
    // Label "page", ↗ glyph (not previewable), "[example.com]" suffix.
    expect(link.textContent).toBe("page↗[example.com]");
  });

  it("keeps a [url] label but still trails the glyph and host", () => {
    render(<RichText bbcode="[url=https://example.com/page]click me[/url]" />);
    const link = screen.getByRole("link", { name: /click me/ });
    const spans = within(link).getAllByText(
      (_content, el) => el?.tagName === "SPAN" && el.children.length === 0,
    );
    // First span is the label, last is the [host] suffix — glyph sits between.
    expect(spans[0]).toHaveTextContent("click me");
    expect(link.textContent).toBe("click me↗[example.com]");
  });
});
