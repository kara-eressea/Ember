// The stuck-search backstop (M10 audit): failSearch may only end the exact
// search that armed it — a reply or a newer search always wins.

import { beforeEach, describe, expect, it } from "vitest";
import { useSearchStore } from "./search.js";

const ID = "11111111-1111-4111-8111-111111111111";

describe("failSearch", () => {
  beforeEach(() => {
    useSearchStore.setState({ byIdentity: {} });
  });

  it("ends a still-wedged search with a refusal", () => {
    const firedAt = useSearchStore.getState().beginSearch(ID);
    useSearchStore.getState().failSearch(ID, firedAt, "lost");
    const state = useSearchStore.getState().byIdentity[ID];
    expect(state?.searching).toBe(false);
    expect(state?.refusal).toEqual({ code: 0, message: "lost" });
  });

  it("no-ops once a reply already settled the search", () => {
    const firedAt = useSearchStore.getState().beginSearch(ID);
    useSearchStore
      .getState()
      .applyOutcome(ID, { ok: true, characters: ["Nyx"], kinks: ["501"] });
    useSearchStore.getState().failSearch(ID, firedAt, "lost");
    const state = useSearchStore.getState().byIdentity[ID];
    expect(state?.searching).toBe(false);
    expect(state?.refusal).toBeUndefined();
    expect(state?.results).toEqual(["Nyx"]);
  });

  it("no-ops when a newer search has since fired", async () => {
    const first = useSearchStore.getState().beginSearch(ID);
    useSearchStore
      .getState()
      .applyOutcome(ID, { ok: false, code: 18, message: "none" });
    // The pace stamp is Date.now(); make sure the second fire differs.
    await new Promise((resolve) => setTimeout(resolve, 2));
    useSearchStore.getState().beginSearch(ID);
    useSearchStore.getState().failSearch(ID, first, "lost");
    expect(useSearchStore.getState().byIdentity[ID]?.searching).toBe(true);
  });

  it("without a stamp, still only ends an in-flight search", () => {
    useSearchStore.getState().failSearch(ID, undefined, "lost");
    expect(useSearchStore.getState().byIdentity[ID]).toBeUndefined();
    useSearchStore.getState().beginSearch(ID);
    useSearchStore.getState().failSearch(ID, undefined, "lost");
    expect(useSearchStore.getState().byIdentity[ID]?.searching).toBe(false);
  });
});
