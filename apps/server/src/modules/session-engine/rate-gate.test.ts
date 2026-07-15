import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FLOOD_MARGIN_MS,
  MAX_QUEUE_LENGTH,
  RateGate,
  RateGateClearedError,
  RateGateFullError,
} from "./rate-gate.js";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("RateGate", () => {
  it("sends the first command immediately and spaces the rest", async () => {
    const gate = new RateGate(() => 0.5);
    const sentAt: number[] = [];
    const all = Promise.all([
      gate.schedule("MSG", () => sentAt.push(Date.now())),
      gate.schedule("MSG", () => sentAt.push(Date.now())),
      gate.schedule("MSG", () => sentAt.push(Date.now())),
    ]);
    await vi.advanceTimersByTimeAsync(2 * (500 + FLOOD_MARGIN_MS));
    await all;
    expect(sentAt).toHaveLength(3);
    expect(sentAt[1]! - sentAt[0]!).toBeGreaterThanOrEqual(500);
    expect(sentAt[2]! - sentAt[1]!).toBeGreaterThanOrEqual(500);
  });

  it("rejects sends beyond the backlog cap instead of queueing forever", async () => {
    const gate = new RateGate(() => 10, { maxQueueLength: 2 });
    const sent: number[] = [];
    const first = gate.schedule("MSG", () => sent.push(1)); // sent immediately
    const queued = gate.schedule("MSG", () => sent.push(2));
    const alsoQueued = gate.schedule("MSG", () => sent.push(3));
    await expect(gate.schedule("MSG", () => sent.push(4))).rejects.toThrow(
      RateGateFullError,
    );
    // The cap is per class: PRI still has room.
    const pri = gate.schedule("PRI", () => sent.push(5));
    await vi.advanceTimersByTimeAsync(3 * (10_000 + FLOOD_MARGIN_MS));
    await Promise.all([first, queued, alsoQueued, pri]);
    expect(sent).toEqual([1, 5, 2, 3]);
    expect(MAX_QUEUE_LENGTH).toBeGreaterThan(0);
  });

  it("keeps MSG and PRI on independent timelines", async () => {
    const gate = new RateGate(() => 10);
    const sent: string[] = [];
    void gate.schedule("MSG", () => sent.push("msg-1"));
    void gate.schedule("MSG", () => sent.push("msg-2"));
    // The PRI class is not delayed by the queued MSG.
    await gate.schedule("PRI", () => sent.push("pri-1"));
    expect(sent).toEqual(["msg-1", "pri-1"]);
    await vi.advanceTimersByTimeAsync(10_000 + FLOOD_MARGIN_MS);
    expect(sent).toEqual(["msg-1", "pri-1", "msg-2"]);
  });

  it("reads the interval at send time (live VAR updates apply)", async () => {
    let interval = 5;
    const gate = new RateGate(() => interval);
    const sentAt: number[] = [];
    void gate.schedule("MSG", () => sentAt.push(Date.now()));
    const second = gate.schedule("MSG", () => sentAt.push(Date.now()));
    // The server lowers msg_flood before the second send is due.
    interval = 1;
    await vi.advanceTimersByTimeAsync(5000 + FLOOD_MARGIN_MS);
    await second;
    // Scheduled with interval 5, so it still waited the full window that was
    // current when the timer was armed — but no longer than that.
    expect(sentAt[1]! - sentAt[0]!).toBeGreaterThanOrEqual(1000);
    expect(sentAt[1]! - sentAt[0]!).toBeLessThanOrEqual(5000 + FLOOD_MARGIN_MS);
  });

  it("clear() rejects queued sends and never runs them", async () => {
    const gate = new RateGate(() => 60);
    const sent: string[] = [];
    await gate.schedule("MSG", () => sent.push("first"));
    const queued = gate.schedule("MSG", () => sent.push("second"));
    gate.clear();
    await expect(queued).rejects.toBeInstanceOf(RateGateClearedError);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(sent).toEqual(["first"]);
  });

  it("rejects the caller when send throws (socket died mid-queue)", async () => {
    const gate = new RateGate(() => 0.1);
    const sent: string[] = [];
    await gate.schedule("MSG", () => sent.push("ok"));
    // The failure surfaces to its caller (handler attached up front — the
    // rejection fires from a timer); the queue keeps draining.
    const dead = expect(
      gate.schedule("MSG", () => {
        throw new Error("socket closed");
      }),
    ).rejects.toThrow("socket closed");
    const after = gate.schedule("MSG", () => sent.push("after"));
    await vi.advanceTimersByTimeAsync(2 * (100 + FLOOD_MARGIN_MS));
    await dead;
    await after;
    expect(sent).toEqual(["ok", "after"]);
  });

  it("recovers after clear(): the next send goes out immediately", async () => {
    const gate = new RateGate(() => 60);
    const sent: string[] = [];
    await gate.schedule("MSG", () => sent.push("first"));
    gate.clear();
    // A new connection has fresh flood accounting server-side, so the same
    // class sends immediately instead of waiting out the old window.
    await gate.schedule("MSG", () => sent.push("after-clear"));
    expect(sent).toEqual(["first", "after-clear"]);
  });
});

describe("waitMs (M6 audit — ad fail-fast)", () => {
  it("reports remaining cooldown plus a full interval per queued item", async () => {
    const gate = new RateGate(() => 600); // the live lfrp pace
    expect(gate.waitMs("LRP:Frontpage")).toBe(0);
    await gate.schedule("LRP:Frontpage", () => {});
    // Slot just used: a new send waits out ~the whole window.
    const wait = gate.waitMs("LRP:Frontpage");
    expect(wait).toBeGreaterThan(590_000);
    expect(wait).toBeLessThanOrEqual(600_100);
    // Classes are independent — another channel's ads are unaffected.
    expect(gate.waitMs("LRP:Development")).toBe(0);
  });
});
