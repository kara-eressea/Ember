// Client idle auto-away: threshold gating, never clobbering a chosen
// status, and clear-on-return restoring only what we replaced. The gateway
// is mocked (node environment); store state is seeded through snapshots.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { PREFS_DEFAULTS, type UserPrefs } from "@emberchat/protocol";

const cmdMock = vi.hoisted(() => vi.fn());
vi.mock("../gateway/socket.js", () => ({ gateway: { cmd: cmdMock } }));
import { useSessionsStore } from "../stores/sessions.js";
import { checkIdle, noteActivity, resetAutoAwayForTest } from "./auto-away.js";

const A = "11111111-1111-7111-8111-111111111111";
const B = "22222222-2222-7222-8222-222222222222";
const MIN = 60_000;

const PREFS_ON: UserPrefs = {
  ...PREFS_DEFAULTS,
  autoAwayEnabled: true,
  autoAwayMinutes: 10,
  autoAwayMessage: "brb — idle",
};

function seedSession(
  identityId: string,
  options: { status?: string; statusmsg?: string; prefs?: UserPrefs } = {},
) {
  useSessionsStore.getState().applySnapshot({
    identityId,
    self: {
      character: `Char ${identityId.slice(0, 4)}`,
      sessionStatus: "online",
      status: options.status ?? "online",
      statusmsg: options.statusmsg ?? "",
      ignores: [],
      limits: { chatMax: 4096, privMax: 50000, lfrpMax: 50000 },
      iconBlacklist: [],
      sendDelaySeconds: 0,
      prefs: options.prefs ?? PREFS_ON,
      outbox: [],
    },
    channels: [],
    dms: [],
  });
}

// Node has no localStorage — a minimal in-memory stand-in lets the tests
// exercise the cross-tab shared-activity path too.
const storage = new Map<string, string>();
beforeEach(() => {
  Object.assign(globalThis, {
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    },
  });
  useSessionsStore.getState().reset();
  cmdMock.mockReset();
  cmdMock.mockResolvedValue({ ok: true });
  resetAutoAwayForTest(0);
});

describe("checkIdle", () => {
  it("sets away on plain-online sessions once past the threshold", () => {
    seedSession(A);
    seedSession(B, { status: "busy", statusmsg: "working" });

    checkIdle(9 * MIN);
    expect(cmdMock).not.toHaveBeenCalled();

    checkIdle(10 * MIN);
    // Only A: B's busy is a chosen status and stays the user's.
    expect(cmdMock.mock.calls).toEqual([
      [
        {
          identityId: A,
          action: "status.set",
          d: { status: "away", statusmsg: "brb — idle" },
        },
      ],
    ]);

    // Already applied — the next tick must not re-send.
    checkIdle(11 * MIN);
    expect(cmdMock).toHaveBeenCalledTimes(1);
  });

  it("does nothing while the pref is off (the default)", () => {
    seedSession(A, { prefs: PREFS_DEFAULTS });
    checkIdle(24 * 60 * MIN);
    expect(cmdMock).not.toHaveBeenCalled();
  });

  it("respects activity from another tab (shared via localStorage)", () => {
    seedSession(A);
    // This tab has been silent since t=0, but a sibling tab saw activity
    // at t=9min — the user is not idle.
    localStorage.setItem("eb.lastActivity", String(9 * MIN));
    checkIdle(15 * MIN);
    expect(cmdMock).not.toHaveBeenCalled();
    checkIdle(19 * MIN); // 10 idle minutes past the sibling's activity
    expect(cmdMock).toHaveBeenCalledTimes(1);
  });
});

describe("noteActivity", () => {
  it("restores the replaced status, keeping its statusmsg", () => {
    seedSession(A, { statusmsg: "sipping tea" });
    checkIdle(10 * MIN);
    cmdMock.mockClear();

    // The STA fan-out landed: the slice shows our away now.
    seedSession(A, { status: "away", statusmsg: "brb — idle" });
    noteActivity(11 * MIN);
    expect(cmdMock.mock.calls).toEqual([
      [
        {
          identityId: A,
          action: "status.set",
          d: { status: "online", statusmsg: "sipping tea" },
        },
      ],
    ]);
  });

  it("leaves a status the user changed meanwhile", () => {
    seedSession(A);
    checkIdle(10 * MIN);
    cmdMock.mockClear();

    seedSession(A, { status: "looking", statusmsg: "open for rp" });
    noteActivity(11 * MIN);
    expect(cmdMock).not.toHaveBeenCalled();
  });

  it("respects clear-on-return off", () => {
    const prefs: UserPrefs = { ...PREFS_ON, autoAwayClearOnReturn: false };
    seedSession(A, { prefs });
    checkIdle(10 * MIN);
    cmdMock.mockClear();

    seedSession(A, { status: "away", statusmsg: "brb — idle", prefs });
    noteActivity(11 * MIN);
    expect(cmdMock).not.toHaveBeenCalled();
  });

  it("restores an away it recognizes even without a local record (reload / other tab)", () => {
    // The bouncer held the auto-away across a reload: status away with
    // exactly the away-message pref, and no `applied` entry in this tab.
    seedSession(A, { status: "away", statusmsg: "brb — idle" });
    noteActivity(1 * MIN);
    expect(cmdMock.mock.calls).toEqual([
      [
        {
          identityId: A,
          action: "status.set",
          d: { status: "online", statusmsg: "" },
        },
      ],
    ]);
  });

  it("never touches a manual away whose message differs from the pref", () => {
    seedSession(A, { status: "away", statusmsg: "at lunch, back at 2" });
    noteActivity(1 * MIN);
    expect(cmdMock).not.toHaveBeenCalled();
  });

  it("leaves a resembling away alone while the feature is off", () => {
    const prefs: UserPrefs = { ...PREFS_DEFAULTS, autoAwayMessage: "" };
    seedSession(A, { status: "away", statusmsg: "", prefs });
    noteActivity(1 * MIN);
    expect(cmdMock).not.toHaveBeenCalled();
  });

  it("activity before the threshold resets the idle clock", () => {
    seedSession(A);
    noteActivity(9 * MIN);
    checkIdle(18 * MIN); // only 9 idle minutes since the activity
    expect(cmdMock).not.toHaveBeenCalled();
    checkIdle(19 * MIN);
    expect(cmdMock).toHaveBeenCalledTimes(1);
  });
});
