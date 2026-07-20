// Ratings store (M11): one load per app session, lowercase-keyed lookups,
// optimistic clear, and save reporting the server's verdict.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../lib/api.js";
import { ratingFor, useRatingsStore } from "./ratings.js";

vi.mock("../lib/api.js", () => ({
  api: {
    getRatings: vi.fn(),
    putRating: vi.fn(),
    deleteRating: vi.fn(),
  },
}));

const mocked = vi.mocked(api);

describe("useRatingsStore", () => {
  beforeEach(() => {
    useRatingsStore.setState({ loaded: false, byName: {} });
    vi.clearAllMocks();
  });

  it("loads once and serves lowercase lookups", async () => {
    mocked.getRatings.mockResolvedValue({
      ratings: [
        { character: "Kolvarr", score: 4, note: "solid", updatedAt: "x" },
      ],
    });
    await useRatingsStore.getState().load();
    await useRatingsStore.getState().load();
    expect(mocked.getRatings.mock.calls).toHaveLength(1);
    const { byName } = useRatingsStore.getState();
    expect(ratingFor(byName, "KOLVARR")?.score).toBe(4);
    expect(ratingFor(byName, "nobody")).toBeUndefined();
  });

  it("save updates the map from the response and reports failures", async () => {
    mocked.putRating.mockResolvedValue({
      rating: { character: "Marrow", score: 2, note: "hm", updatedAt: "x" },
    });
    expect(await useRatingsStore.getState().save("Marrow", 2, "hm")).toBe(true);
    expect(ratingFor(useRatingsStore.getState().byName, "marrow")?.score).toBe(
      2,
    );

    mocked.putRating.mockRejectedValue(new Error("500"));
    expect(await useRatingsStore.getState().save("Marrow", 5)).toBe(false);
    // The failed save leaves the last good state in place.
    expect(ratingFor(useRatingsStore.getState().byName, "marrow")?.score).toBe(
      2,
    );
  });

  it("clear removes locally even when the server row is already gone", async () => {
    useRatingsStore.setState({
      loaded: true,
      byName: {
        thistle: { character: "Thistle", score: 5, updatedAt: "x" },
      },
    });
    mocked.deleteRating.mockRejectedValue(new Error("404"));
    await useRatingsStore.getState().clear("Thistle");
    expect(useRatingsStore.getState().byName["thistle"]).toBeUndefined();
  });
});
