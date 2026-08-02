// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import type { MetaDto } from "./api.js";
import { displayVersion } from "./use-meta.js";

const getMeta = vi.hoisted(() => vi.fn());
vi.mock("./api.js", () => ({ api: { getMeta } }));

const meta: MetaDto = {
  version: "0.19.1",
  updateAvailable: false,
  releasesUrl: "https://example.invalid/releases",
};

/** The shared-fetch cache is module state, so each test gets a fresh copy. */
async function freshHook() {
  vi.resetModules();
  const module = await import("./use-meta.js");
  return module.useServerMeta;
}

beforeEach(() => {
  getMeta.mockReset();
});

describe("displayVersion", () => {
  it("normalises the leading v across tags and CLIENT_VERSION", () => {
    expect(displayVersion("0.19.1")).toBe("v0.19.1");
    expect(displayVersion("v0.19.2")).toBe("v0.19.2");
    expect(displayVersion("0.0.0-dev")).toBe("v0.0.0-dev");
  });
});

describe("useServerMeta", () => {
  it("fetches once however many consumers ask", async () => {
    getMeta.mockResolvedValue(meta);
    const useServerMeta = await freshHook();

    const head = renderHook(() => useServerMeta());
    const about = renderHook(() => useServerMeta());

    await waitFor(() => {
      expect(head.result.current).toEqual(meta);
    });
    await waitFor(() => {
      expect(about.result.current).toEqual(meta);
    });
    expect(getMeta).toHaveBeenCalledTimes(1);
  });

  it("stays undefined on failure and lets a later mount retry", async () => {
    getMeta.mockRejectedValueOnce(new Error("offline")).mockResolvedValue(meta);
    const useServerMeta = await freshHook();

    const failed = renderHook(() => useServerMeta());
    await waitFor(() => {
      expect(getMeta).toHaveBeenCalledTimes(1);
    });
    expect(failed.result.current).toBeUndefined();

    const retried = renderHook(() => useServerMeta());
    await waitFor(() => {
      expect(retried.result.current).toEqual(meta);
    });
  });
});
