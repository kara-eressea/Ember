// SocialService unit tests (#364): the RTB-driven refresh must coalesce —
// a burst of friend events costs one four-call refetch, not one each — and
// must fan the fresh lists out to every attached device. The route/gateway
// integration lives in social.test.ts and gateway.test.ts.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../../db/index.js";
import type {
  FlistApiClient,
  SessionRegistry,
  TicketManagerRegistry,
} from "@emberchat/session-engine";
import type { GatewayHub } from "../gateway/gateway.js";
import { SocialCache } from "./cache.js";
import { SocialService } from "./service.js";

const IDENTITY = {
  id: "identity-1",
  character: "Fern Glade",
  accountId: "account-1",
  accountName: "fern@example.test",
};

/** The service's only query: identity + account by identity id. */
function fakeDb(row: typeof IDENTITY | undefined = IDENTITY): Db {
  const result = { limit: () => Promise.resolve(row ? [row] : []) };
  return {
    select: () => ({
      from: () => ({ innerJoin: () => ({ where: () => result }) }),
    }),
  } as unknown as Db;
}

/** Counts ticket acquisitions: every one of them invalidates the account's
 * previous ticket on F-List, so "did this path take a ticket at all" is the
 * property #546 turns on, not just "did it fetch". */
function fakeTickets(onGetTicket: () => void): TicketManagerRegistry {
  return {
    managerFor: () => ({
      getTicket: () => {
        onGetTicket();
        return Promise.resolve("ticket-1");
      },
    }),
  } as unknown as TicketManagerRegistry;
}

/** An RTB refresh is always scheduled by a live session, so the registry
 * answers with one unless a case is specifically about a stopped identity.
 * The object only has to be non-undefined: `enriched` reads its roster,
 * which is empty here. */
function fakeSessions(live = true): SessionRegistry {
  return {
    get: () => (live ? { state: { characters: new Map() } } : undefined),
  } as unknown as SessionRegistry;
}

interface Harness {
  service: SocialService;
  cache: SocialCache;
  broadcasts: { identityId: string; friends: string[] }[];
  fetches: () => number;
  /** Ticket acquisitions the refresh path asked for (#546). */
  ticketsTaken: () => number;
  /** Resolves the pending friendList call (in-flight coalescing test). */
  release: () => void;
}

function buildService(options?: { hold?: boolean; live?: boolean }): Harness {
  const cache = new SocialCache();
  const broadcasts: Harness["broadcasts"] = [];
  let calls = 0;
  let ticketsTaken = 0;
  let release = () => undefined as void;
  const flistApi = {
    bookmarkList: () => Promise.resolve({ error: "", characters: [] }),
    friendList: () => {
      calls += 1;
      const payload = {
        error: "",
        friends: [{ source: "Fern Glade", dest: "Tally Marsh" }],
      };
      if (options?.hold !== true) {
        return Promise.resolve(payload);
      }
      return new Promise((resolve) => {
        release = () => resolve(payload);
      });
    },
    requestList: () => Promise.resolve({ error: "", requests: [] }),
    requestPending: () => Promise.resolve({ error: "", requests: [] }),
  } as unknown as FlistApiClient;
  const hub = {
    broadcast: (
      identityId: string,
      event: { d: { social: { friends: { name: string }[] } } },
    ) => {
      broadcasts.push({
        identityId,
        friends: event.d.social.friends.map((row) => row.name),
      });
    },
  } as unknown as GatewayHub;
  const service = new SocialService({
    db: fakeDb(),
    sessions: fakeSessions(options?.live ?? true),
    tickets: fakeTickets(() => {
      ticketsTaken += 1;
    }),
    flistApi,
    cache,
    hub,
    logger: { warn: () => undefined } as never,
    debounceMs: 50,
  });
  return {
    service,
    cache,
    broadcasts,
    fetches: () => calls,
    ticketsTaken: () => ticketsTaken,
    release: () => {
      release();
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("SocialService.refreshSoon", () => {
  it("coalesces a burst into one refetch and fans the lists out", async () => {
    const { service, cache, broadcasts, fetches } = buildService();
    // A friend accept lands friendadd on both parties and often rides
    // alongside friendrequest — one burst, one refetch.
    service.refreshSoon(IDENTITY.id);
    service.refreshSoon(IDENTITY.id);
    service.refreshSoon(IDENTITY.id);
    expect(fetches()).toBe(0);
    await vi.advanceTimersByTimeAsync(60);
    expect(fetches()).toBe(1);
    expect(cache.get(IDENTITY.id)?.friends).toEqual(["Tally Marsh"]);
    expect(broadcasts).toEqual([
      { identityId: IDENTITY.id, friends: ["Tally Marsh"] },
    ]);
  });

  it("runs once more for events that arrive mid-fetch", async () => {
    const { service, fetches, release } = buildService({ hold: true });
    service.refreshSoon(IDENTITY.id);
    await vi.advanceTimersByTimeAsync(60);
    expect(fetches()).toBe(1);
    // Arrives while the four calls are still out: no second concurrent
    // fetch, but the state it reported must not be lost either.
    service.refreshSoon(IDENTITY.id);
    await vi.advanceTimersByTimeAsync(60);
    expect(fetches()).toBe(1);
    release();
    await vi.advanceTimersByTimeAsync(60);
    expect(fetches()).toBe(2);
  });

  it("schedules again after the window, and stop() drops pending work", async () => {
    const { service, fetches } = buildService();
    service.refreshSoon(IDENTITY.id);
    await vi.advanceTimersByTimeAsync(60);
    service.refreshSoon(IDENTITY.id);
    await vi.advanceTimersByTimeAsync(60);
    expect(fetches()).toBe(2);
    service.refreshSoon(IDENTITY.id);
    service.stop();
    await vi.advanceTimersByTimeAsync(200);
    expect(fetches()).toBe(2);
  });

  it("drops a refresh whose session stopped inside the window (#546)", async () => {
    // RTB is a live-socket event: if the session is gone when the debounce
    // fires, there is no device to fan out to. The refetch must not happen
    // — not because the work is wasted, but because it would take a
    // ticket, and F-List invalidates tickets per ACCOUNT. A mint here
    // breaks the ticket every other session on the same F-List account is
    // holding; one identifying at that instant takes ERR 4 and reconnects
    // on the 10-second policy floor, which is the CI flake in #546.
    const { service, fetches, ticketsTaken } = buildService({ live: false });
    service.refreshSoon(IDENTITY.id);
    await vi.advanceTimersByTimeAsync(200);
    expect(fetches()).toBe(0);
    expect(ticketsTaken()).toBe(0);
  });
});
