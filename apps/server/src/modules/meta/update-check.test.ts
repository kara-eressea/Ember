import { describe, expect, it, vi } from "vitest";
import { compareVersions, UpdateChecker } from "./update-check.js";

function githubResponse(tag: string, ok = true): Response {
  return {
    ok,
    status: ok ? 200 : 503,
    json: () => Promise.resolve({ tag_name: tag }),
  } as unknown as Response;
}

describe("compareVersions", () => {
  it("orders dotted versions, tolerating a leading v", () => {
    expect(compareVersions("v0.6.0", "0.5.0")).toBeGreaterThan(0);
    expect(compareVersions("0.5.0", "v0.5.0")).toBe(0);
    expect(compareVersions("0.5.1", "0.5.2")).toBeLessThan(0);
    expect(compareVersions("1.0.0", "0.99.99")).toBeGreaterThan(0);
    // Garbage never announces an update.
    expect(compareVersions("not-a-version", "0.5.0")).toBeLessThan(0);
  });
});

describe("UpdateChecker", () => {
  it("flags a newer release and points at the releases page", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(githubResponse("v0.6.0"));
    const checker = new UpdateChecker({
      currentVersion: "0.5.0",
      repo: "kara-eressea/Ember",
      enabled: true,
      fetchImpl: fetchImpl,
    });
    await checker.checkOnce();
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.github.com/repos/kara-eressea/Ember/releases/latest",
      expect.anything(),
    );
    expect(checker.status).toEqual({
      version: "0.5.0",
      updateAvailable: true,
      latestVersion: "v0.6.0",
      releasesUrl: "https://github.com/kara-eressea/Ember/releases",
    });
  });

  it("stays quiet when current, on errors, and on non-OK responses", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(githubResponse("v0.5.0"))
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(githubResponse("", false));
    const checker = new UpdateChecker({
      currentVersion: "0.5.0",
      repo: "kara-eressea/Ember",
      enabled: true,
      fetchImpl: fetchImpl,
    });
    await checker.checkOnce(); // same version
    expect(checker.status.updateAvailable).toBe(false);
    await checker.checkOnce(); // network error — never throws
    await checker.checkOnce(); // 503 — ignored
    expect(checker.status.updateAvailable).toBe(false);
    expect(checker.status.latestVersion).toBe("v0.5.0");
  });

  it("start() is a no-op when the phone-home is disabled", () => {
    const fetchImpl = vi.fn();
    const checker = new UpdateChecker({
      currentVersion: "0.5.0",
      repo: "kara-eressea/Ember",
      enabled: false,
      fetchImpl: fetchImpl,
    });
    checker.start();
    checker.stop();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
