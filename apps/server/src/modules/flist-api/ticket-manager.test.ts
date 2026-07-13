import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiTicketResponse } from "@emberchat/fchat-protocol";
import type { GetApiTicketParams } from "./api-client.js";
import {
  AccountLockedError,
  FlistAuthError,
  TicketManager,
  type TicketApi,
} from "./ticket-manager.js";

function stubApi(
  respond: (
    params: GetApiTicketParams,
    callIndex: number,
  ) => ApiTicketResponse | Promise<ApiTicketResponse>,
) {
  const calls: GetApiTicketParams[] = [];
  const api: TicketApi = {
    getApiTicket: (params) => {
      calls.push(params);
      return Promise.resolve(respond(params, calls.length - 1));
    },
  };
  return { api, calls };
}

const ok = (ticket: string): ApiTicketResponse => ({ error: "", ticket });

function manager(
  api: TicketApi,
  getPassword: () => string | undefined = () => "hunter2",
) {
  return new TicketManager({
    accountName: "amber@example.test",
    getPassword,
    apiClient: api,
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("TicketManager", () => {
  it("coalesces concurrent callers into one fetch", async () => {
    let release!: (value: ApiTicketResponse) => void;
    const gate = new Promise<ApiTicketResponse>(
      (resolve) => (release = resolve),
    );
    const { api, calls } = stubApi(() => gate);
    const m = manager(api);
    const results = Promise.all([
      m.getTicket(),
      m.getTicket(),
      m.getTicket(),
      m.getTicket(),
    ]);
    release(ok("fct_one"));
    expect(await results).toEqual(["fct_one", "fct_one", "fct_one", "fct_one"]);
    expect(calls).toHaveLength(1);
  });

  it("reuses a fresh ticket and refetches after ~25 minutes", async () => {
    const { api, calls } = stubApi((_p, i) => ok(`fct_${String(i)}`));
    const m = manager(api);
    expect(await m.getTicket()).toBe("fct_0");
    vi.advanceTimersByTime(20 * 60 * 1000);
    expect(await m.getTicket()).toBe("fct_0");
    expect(calls).toHaveLength(1);
    vi.advanceTimersByTime(6 * 60 * 1000); // 26 min after issue
    expect(await m.getTicket()).toBe("fct_1");
    expect(calls).toHaveLength(2);
  });

  it("refetches after invalidate()", async () => {
    const { api, calls } = stubApi((_p, i) => ok(`fct_${String(i)}`));
    const m = manager(api);
    await m.getTicket();
    m.invalidate();
    expect(await m.getTicket()).toBe("fct_1");
    expect(calls).toHaveLength(2);
  });

  it("requests no character/friend/bookmark data for plain tickets", async () => {
    const { api, calls } = stubApi(() => ok("fct_x"));
    await manager(api).getTicket();
    expect(calls[0]).toMatchObject({
      account: "amber@example.test",
      password: "hunter2",
      noCharacters: true,
      noFriends: true,
      noBookmarks: true,
    });
  });

  it("throws AccountLockedError without fetching when the vault is empty", async () => {
    const { api, calls } = stubApi(() => ok("fct_x"));
    const m = manager(api, () => undefined);
    await expect(m.getTicket()).rejects.toBeInstanceOf(AccountLockedError);
    expect(calls).toHaveLength(0);
  });

  it("throws FlistAuthError on rejection and does not cache, so callers can retry", async () => {
    const { api, calls } = stubApi((_p, i) =>
      i === 0 ? { error: "Invalid username or password." } : ok("fct_retry"),
    );
    const m = manager(api);
    await expect(m.getTicket()).rejects.toBeInstanceOf(FlistAuthError);
    expect(await m.getTicket()).toBe("fct_retry");
    expect(calls).toHaveLength(2);
  });

  it("getTicketWithCharacters always fetches and refreshes the cache for getTicket", async () => {
    const { api, calls } = stubApi((params, i) => ({
      error: "",
      ticket: `fct_${String(i)}`,
      ...(params.noCharacters ? {} : { characters: ["Amber Vale", "Cindral"] }),
    }));
    const m = manager(api);
    await m.getTicket(); // fct_0, cached
    const withCharacters = await m.getTicketWithCharacters(); // always fetches → fct_1
    expect(withCharacters).toEqual({
      ticket: "fct_1",
      characters: ["Amber Vale", "Cindral"],
    });
    expect(calls[1]).toMatchObject({ noCharacters: false });
    // The fresh ticket from the characters fetch now serves plain callers.
    expect(await m.getTicket()).toBe("fct_1");
    expect(calls).toHaveLength(2);
  });
});
