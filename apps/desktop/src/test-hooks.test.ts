import { describe, expect, it } from "vitest";
import { lifecycleProbe, LIFECYCLE_PROBE_ENV } from "./test-hooks.js";

describe("the lifecycle probe", () => {
  it("is off unless the environment asks for it", () => {
    // The property that makes it safe to keep in the shipped shell: an app
    // nobody asked to close its own window does not close its own window.
    expect(lifecycleProbe({})).toBeUndefined();
    expect(lifecycleProbe({ [LIFECYCLE_PROBE_ENV]: "" })).toBeUndefined();
    expect(lifecycleProbe({ [LIFECYCLE_PROBE_ENV]: "1" })).toBeUndefined();
    expect(lifecycleProbe({ [LIFECYCLE_PROBE_ENV]: "true" })).toBeUndefined();
  });

  it("understands its two steps", () => {
    expect(lifecycleProbe({ [LIFECYCLE_PROBE_ENV]: "close" })).toBe("close");
    expect(lifecycleProbe({ [LIFECYCLE_PROBE_ENV]: " close-then-quit " })).toBe(
      "close-then-quit",
    );
  });
});
