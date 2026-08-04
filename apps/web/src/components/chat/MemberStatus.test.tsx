// @vitest-environment jsdom
//
// The rendered member-row status (#494): the colour that used to be stripped
// now paints, an [eicon] renders inside the row's line box rather than the
// log's 60px box, and the eicon prefs a blocked image relies on still hold.

import { afterEach, describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { PREFS_DEFAULTS, type UserPrefs } from "@emberchat/protocol";
import { MemberStatus } from "./MemberStatus.js";
import {
  useSessionsStore,
  type IdentitySession,
} from "../../stores/sessions.js";

const initialSessions = useSessionsStore.getState().sessions;
afterEach(() => {
  useSessionsStore.setState({ sessions: initialSessions });
});

function seedPrefs(patch: Partial<UserPrefs>): void {
  useSessionsStore.setState({
    sessions: {
      id1: {
        identityId: "id1",
        prefs: { ...PREFS_DEFAULTS, ...patch },
        synced: true,
      } as unknown as IdentitySession,
    },
  });
}

describe("member-row status rendering (#494)", () => {
  it("paints a [color] status instead of stripping the tag", () => {
    render(<MemberStatus statusmsg="[color=green]open for RP[/color]" />);
    const run = screen.getByText("open for RP");
    // The colour comes from the shared BBCode colour class, never an inline
    // hex (COMPONENTS.md: tokens only).
    expect(run.className).toContain("bbc-green");
    expect(run.getAttribute("style")).toBeNull();
    // And no raw tag survives anywhere in the line.
    expect(screen.queryByText(/\[color/)).not.toBeInTheDocument();
  });

  it("keeps the flattened text as the hover tooltip", () => {
    const { container } = render(
      <MemberStatus statusmsg="[color=red]busy[/color] [eicon]sparkle[/eicon]" />,
    );
    expect(container.querySelector("[title]")).toHaveAttribute("title", "busy");
  });

  it("renders an [eicon] pinned to the row's line box, not the log's 60px box", () => {
    render(<MemberStatus statusmsg="mood [eicon]sparkle[/eicon]" />);
    const icon = screen.getByRole("img", { name: "sparkle" });
    expect(icon).toHaveAttribute(
      "src",
      "https://static.f-list.net/images/eicon/sparkle.gif",
    );
    // Explicit small dimensions reserve the space before the image loads —
    // the row's height can never depend on what someone put in their status.
    expect(icon).toHaveAttribute("width", "14");
    expect(icon).toHaveAttribute("height", "14");
    expect(icon).toHaveAttribute("loading", "lazy");
  });

  it("renders no control inside the row — the row itself is the button", () => {
    // [url]/[user]/#channel would each be a <button>/<a> in the message
    // renderer, which a <button> row cannot legally nest.
    const { container } = render(
      <MemberStatus statusmsg="ping [user]Mara Quill[/user] [url=https://x.example]here[/url]" />,
    );
    expect(container.querySelectorAll("button, a")).toHaveLength(0);
    expect(screen.getByText("ping Mara Quill here")).toBeInTheDocument();
  });

  it("shows a blocked eicon as its name, never its image", () => {
    seedPrefs({ eiconBlocked: ["Sparkle"] });
    render(<MemberStatus statusmsg="mood [eicon]sparkle[/eicon]" />);
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(screen.getByText(/sparkle/)).toBeInTheDocument();
  });

  it("shows names instead of images in the name-only display mode", () => {
    seedPrefs({ eiconDisplay: "name" });
    render(<MemberStatus statusmsg="[eicon]sparkle[/eicon]" />);
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });

  it("freezes the eicon when animation is off", () => {
    seedPrefs({ animateEicons: false });
    const { container } = render(
      <MemberStatus statusmsg="[eicon]sparkle[/eicon]" />,
    );
    expect(container.querySelector("canvas")).toHaveAttribute(
      "aria-label",
      "sparkle",
    );
    expect(container.querySelector("img")).toBeNull();
  });

  it("renders nothing at all for an empty status", () => {
    const { container } = render(<MemberStatus statusmsg="" />);
    expect(container).toBeEmptyDOMElement();
  });
});
