import { afterEach, describe, expect, it, vi } from "vitest";
import { TicketService } from "./ticket-service.js";
import { DEFAULT_WORLD } from "./world.js";

const ACCOUNT = "amber@example.test";
const PASSWORD = DEFAULT_WORLD.accounts[ACCOUNT]!.password;
const MINUTE_MS = 60_000;

function issue(service: TicketService): string {
  const ticket = service.issue(ACCOUNT, PASSWORD);
  if (ticket === undefined) {
    throw new Error("expected a ticket");
  }
  return ticket;
}

describe("TicketService", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("expires a ticket 30 minutes after issuance", () => {
    vi.useFakeTimers();
    const tickets = new TicketService(DEFAULT_WORLD.accounts);
    const ticket = issue(tickets);

    vi.advanceTimersByTime(29 * MINUTE_MS);
    expect(tickets.validate(ACCOUNT, ticket)).toBe(true);
    vi.advanceTimersByTime(2 * MINUTE_MS);
    expect(tickets.validate(ACCOUNT, ticket)).toBe(false);
  });

  it("honours a configured ttl", () => {
    vi.useFakeTimers();
    const tickets = new TicketService(DEFAULT_WORLD.accounts, { ttlMs: 1000 });
    const ticket = issue(tickets);

    vi.advanceTimersByTime(999);
    expect(tickets.validate(ACCOUNT, ticket)).toBe(true);
    vi.advanceTimersByTime(1);
    expect(tickets.validate(ACCOUNT, ticket)).toBe(false);
  });

  it("re-issuing restarts the clock and still invalidates the old ticket", () => {
    vi.useFakeTimers();
    const tickets = new TicketService(DEFAULT_WORLD.accounts);
    const first = issue(tickets);

    vi.advanceTimersByTime(29 * MINUTE_MS);
    const second = issue(tickets);
    // Newest-ticket-only is unchanged by the TTL: the old one dies at once,
    // the new one gets a full 30 minutes of its own.
    expect(tickets.validate(ACCOUNT, first)).toBe(false);
    vi.advanceTimersByTime(29 * MINUTE_MS);
    expect(tickets.validate(ACCOUNT, second)).toBe(true);
  });

  it("refuses an empty ticket and unknown accounts", () => {
    const tickets = new TicketService(DEFAULT_WORLD.accounts);
    issue(tickets);
    expect(tickets.validate(ACCOUNT, "")).toBe(false);
    expect(tickets.issue(ACCOUNT, "wrong")).toBeUndefined();
    expect(tickets.issue("nobody@example.test", PASSWORD)).toBeUndefined();
  });
});
