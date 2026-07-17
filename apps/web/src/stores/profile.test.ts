// loadProfile semantics: in-flight dedup, client-cache hits stay off the
// wire (but still bump the rail), and the 404/429 error mapping the viewer
// states render from.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProfileResponse } from "@emberchat/protocol";
import { api, ApiError } from "../lib/api.js";
import { loadProfile, useProfileStore } from "./profile.js";

const ID = "11111111-1111-4111-8111-111111111111";

function response(name: string): ProfileResponse {
  return {
    profile: {
      id: 1,
      name,
      description: "[b]hi[/b]",
      views: 1,
      customTitle: null,
      customsFirst: false,
      createdAt: null,
      updatedAt: null,
      settings: {
        guestbook: false,
        showFriends: false,
        preventBookmarks: false,
        public: true,
      },
      badges: [],
      infotagGroups: [],
      kinks: [],
      customKinks: [],
      images: [],
      timezone: null,
    },
    fetchedAt: 1_752_000_000_000,
    stale: false,
    budgetExhausted: false,
    note: null,
  };
}

beforeEach(() => {
  useProfileStore.setState({
    viewing: undefined,
    activeTab: "overview",
    profiles: {},
    history: [],
    insights: {},
    ownProfile: undefined,
  });
  vi.restoreAllMocks();
});

describe("loadProfile", () => {
  it("single-flights concurrent loads and canonicalizes casing", async () => {
    let resolve!: (value: ProfileResponse) => void;
    const spy = vi.spyOn(api, "getProfile").mockReturnValue(
      new Promise((r) => {
        resolve = r;
      }),
    );
    const first = loadProfile(ID, "nyx firemane");
    const second = loadProfile(ID, "Nyx Firemane");
    expect(spy).toHaveBeenCalledTimes(1);
    resolve(response("Nyx Firemane"));
    await Promise.all([first, second]);
    const state = useProfileStore.getState();
    expect(state.profiles["nyx firemane"]?.state).toBe("ok");
    expect(state.history[0]?.name).toBe("Nyx Firemane");
  });

  it("serves client-cache hits without touching the API, still bumps the rail", async () => {
    const spy = vi
      .spyOn(api, "getProfile")
      .mockResolvedValue(response("Nyx Firemane"));
    await loadProfile(ID, "Nyx Firemane");
    useProfileStore.setState({ history: [] });
    spy.mockClear();
    await loadProfile(ID, "Nyx Firemane");
    expect(spy).not.toHaveBeenCalled();
    expect(useProfileStore.getState().history[0]?.name).toBe("Nyx Firemane");
  });

  it("refresh bypasses the client cache", async () => {
    const spy = vi
      .spyOn(api, "getProfile")
      .mockResolvedValue(response("Nyx Firemane"));
    await loadProfile(ID, "Nyx Firemane");
    await loadProfile(ID, "Nyx Firemane", true);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy).toHaveBeenLastCalledWith(ID, "Nyx Firemane", true);
  });

  it("maps 404 to notfound and 429 to budget (keeping any cached copy)", async () => {
    vi.spyOn(api, "getProfile").mockRejectedValue(
      new ApiError(404, "Character not found."),
    );
    await loadProfile(ID, "Nobody Realsson");
    expect(
      useProfileStore.getState().profiles["nobody realsson"],
    ).toMatchObject({ state: "notfound", error: "Character not found." });

    vi.spyOn(api, "getProfile").mockResolvedValueOnce(response("Tally Marsh"));
    await loadProfile(ID, "Tally Marsh");
    vi.spyOn(api, "getProfile").mockRejectedValue(
      new ApiError(429, "Hourly profile budget exhausted"),
    );
    await loadProfile(ID, "Tally Marsh", true);
    const loaded = useProfileStore.getState().profiles["tally marsh"];
    expect(loaded?.state).toBe("budget");
    expect(loaded?.response?.profile.name).toBe("Tally Marsh");
  });
});
