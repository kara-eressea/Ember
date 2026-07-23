// @vitest-environment jsdom
//
// #365: the full profile header shows the character's current STA status
// message under their name — the same live, session-derived data the mini
// card renders (findStatusMessage), rendered through RichText so BBCode never
// shows raw. When no status is set (offline / empty message) no line appears.

import { afterEach, describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { Header } from "./ProfileViewer.js";
import {
  useSessionsStore,
  type IdentitySession,
} from "../../stores/sessions.js";

const initialSessions = useSessionsStore.getState().sessions;
afterEach(() => {
  useSessionsStore.setState({ sessions: initialSessions });
});

function seedSession(name: string, statusmsg: string) {
  const session = {
    identityId: "id1",
    character: "Me",
    channels: {
      Frontpage: {
        members: [{ character: name, statusmsg }],
      },
    },
    dms: {},
  } as unknown as IdentitySession;
  useSessionsStore.setState({ sessions: { id1: session } });
}

const profile = { name: "Ada Lovelace" } as never;

describe("full profile header status line (#365)", () => {
  it("renders the status message under the name when one is set", () => {
    seedSession("Ada Lovelace", "[b]Looking[/b] for adventures");
    render(<Header identityId="id1" profile={profile} />);
    // RichText renders the BBCode, not the raw tag text.
    expect(screen.getByText(/Looking/)).toBeInTheDocument();
    expect(screen.queryByText(/\[b\]/)).not.toBeInTheDocument();
  });

  it("renders no status line when the message is empty (offline)", () => {
    seedSession("Ada Lovelace", "");
    const { container } = render(<Header identityId="id1" profile={profile} />);
    expect(container.textContent).not.toContain("Looking");
    // The name still renders — only the status line is absent.
    expect(screen.getByText("Ada Lovelace")).toBeInTheDocument();
  });
});
