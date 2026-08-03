// @vitest-environment jsdom
//
// MP1 §5-F: an affordance reached only through :hover does not exist where
// the pointer cannot hover. The name-only eicon chip is the case with real
// behaviour behind it (the rest of the sweep is CSS) — its whole purpose is
// the preview, and mouseenter never fires on a phone, so a tap has to stand
// in. On a desktop pointer the chip must be untouched: no role, no click
// handler it never had.

import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PREFS_DEFAULTS, type UserPrefs } from "@emberchat/protocol";
import { RichText } from "./RichText.js";
import {
  useSessionsStore,
  type IdentitySession,
} from "../../stores/sessions.js";
import { useUiStore } from "../../stores/ui.js";

vi.mock("../../gateway/socket.js", () => ({
  gateway: { cmd: vi.fn().mockResolvedValue({ ok: true }) },
}));
vi.mock("react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-router")>()),
  useNavigate: () => vi.fn(),
}));

const IDENTITY = "id1";

function seedPrefs(patch: Partial<UserPrefs> = {}): void {
  const session = {
    identityId: IDENTITY,
    character: "Me",
    sessionStatus: "online",
    ownStatus: "online",
    prefs: { ...PREFS_DEFAULTS, ...patch },
    channels: {},
    dms: {},
    channelByConvId: {},
    synced: true,
  } as unknown as IdentitySession;
  useSessionsStore.setState({ sessions: { [IDENTITY]: session } });
  useUiStore.setState({ activeIdentityId: IDENTITY });
}

/** jsdom ships no matchMedia at all, which is already the "has a hover"
 * answer (useNoHover defaults to false). This installs one that says the
 * primary pointer cannot hover. */
function stubNoHover(noHover: boolean): void {
  vi.stubGlobal(
    "matchMedia",
    (query: string): MediaQueryList =>
      ({
        matches: query === "(hover: none)" ? noHover : false,
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }) as unknown as MediaQueryList,
  );
}

const initialSessions = useSessionsStore.getState().sessions;
afterEach(() => {
  useSessionsStore.setState({ sessions: initialSessions });
  useUiStore.setState({ activeIdentityId: undefined });
  vi.unstubAllGlobals();
});

describe("the name-only eicon chip without a hover", () => {
  it("opens its preview on a tap, and closes it on the next one", async () => {
    stubNoHover(true);
    seedPrefs({ eiconDisplay: "name" });
    const user = userEvent.setup();
    const { container } = render(<RichText bbcode="[eicon]sparkle[/eicon]" />);

    const chip = screen.getByRole("button", { name: "sparkle — show eicon" });
    expect(container.querySelector("img")).toBeNull();

    await user.click(chip);
    expect(container.querySelector("img")).not.toBeNull();
    expect(chip).toHaveAttribute("aria-expanded", "true");

    await user.click(chip);
    expect(container.querySelector("img")).toBeNull();
  });

  it("stays inert for a blocked eicon — a tappable block is not a block", async () => {
    stubNoHover(true);
    seedPrefs({ eiconDisplay: "name", eiconBlocked: ["sparkle"] });
    const user = userEvent.setup();
    const { container } = render(<RichText bbcode="[eicon]sparkle[/eicon]" />);

    expect(screen.queryByRole("button")).toBeNull();
    await user.click(screen.getByTitle("sparkle — blocked eicon"));
    expect(container.querySelector("img")).toBeNull();
  });

  it("is the plain hover chip again where the pointer can hover", async () => {
    stubNoHover(false);
    seedPrefs({ eiconDisplay: "name" });
    const user = userEvent.setup();
    const { container } = render(<RichText bbcode="[eicon]sparkle[/eicon]" />);

    // No role, and no click handler to toggle with — a bare click (one that
    // doesn't move a pointer over the chip first) does nothing. Only hover
    // opens it, exactly as before.
    expect(screen.queryByRole("button")).toBeNull();
    fireEvent.click(screen.getByTitle("[eicon]"));
    expect(container.querySelector("img")).toBeNull();

    await user.hover(screen.getByTitle("[eicon]"));
    expect(container.querySelector("img")).not.toBeNull();
  });
});
