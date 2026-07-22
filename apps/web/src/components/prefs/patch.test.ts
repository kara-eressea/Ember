// patchPrefs: optimistic apply to every slice + theme repaint, rollback on
// a refused ack. The gateway and theme are mocked (node environment).

import { beforeEach, describe, expect, it, vi } from "vitest";
import { PREFS_DEFAULTS } from "@emberchat/protocol";

const cmdMock = vi.hoisted(() => vi.fn());
vi.mock("../../gateway/socket.js", () => ({ gateway: { cmd: cmdMock } }));
vi.mock("../../theme/theme.js", () => ({
  hydrateTheme: vi.fn(),
  hydrateInterface: vi.fn(),
}));
import { useSessionsStore } from "../../stores/sessions.js";
import { hydrateTheme } from "../../theme/theme.js";
import { patchPrefs } from "./patch.js";

const A = "11111111-1111-7111-8111-111111111111";
const B = "22222222-2222-7222-8222-222222222222";

describe("patchPrefs", () => {
  beforeEach(() => {
    useSessionsStore.getState().reset();
    // Two slices — prefs are per user, so both must move together.
    useSessionsStore.getState().applyPrefs(A, {
      sendDelaySeconds: 0,
      prefs: PREFS_DEFAULTS,
    });
    useSessionsStore.getState().applyPrefs(B, {
      sendDelaySeconds: 0,
      prefs: PREFS_DEFAULTS,
    });
    cmdMock.mockReset();
    vi.mocked(hydrateTheme).mockReset();
  });

  it("applies optimistically to every slice and sends the sparse patch", async () => {
    cmdMock.mockResolvedValue({ ok: true });
    const ok = await patchPrefs(A, { accent: "moss" });
    expect(ok).toBe(true);
    const sessions = useSessionsStore.getState().sessions;
    expect(sessions[A]?.prefs.accent).toBe("moss");
    expect(sessions[B]?.prefs.accent).toBe("moss");
    expect(hydrateTheme).toHaveBeenCalledWith({
      ...PREFS_DEFAULTS,
      accent: "moss",
    });
    expect(cmdMock).toHaveBeenCalledWith({
      identityId: A,
      action: "prefs.set",
      d: { prefs: { accent: "moss" } },
    });
  });

  it("rolls back every slice and the theme when the ack refuses", async () => {
    cmdMock.mockResolvedValue({ ok: false, error: "nope" });
    const ok = await patchPrefs(A, { accent: "moss" });
    expect(ok).toBe(false);
    const sessions = useSessionsStore.getState().sessions;
    expect(sessions[A]?.prefs.accent).toBe("dusk");
    expect(sessions[B]?.prefs.accent).toBe("dusk");
    expect(hydrateTheme).toHaveBeenLastCalledWith(PREFS_DEFAULTS);
  });
});
