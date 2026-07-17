import { describe, expect, it } from "vitest";
import { CharacterDataBudget } from "./character-data-budget.js";

function makeBudget(limit: number, windowMs: number) {
  let now = 1_000_000;
  const budget = new CharacterDataBudget({
    limit,
    windowMs,
    now: () => now,
  });
  return { budget, advance: (ms: number) => (now += ms) };
}

describe("CharacterDataBudget", () => {
  it("allows up to the limit, then denies", () => {
    const { budget } = makeBudget(3, 1000);
    expect(budget.tryConsume()).toBe(true);
    expect(budget.tryConsume()).toBe(true);
    expect(budget.tryConsume()).toBe(true);
    expect(budget.tryConsume()).toBe(false);
    expect(budget.used).toBe(3);
    expect(budget.remaining).toBe(0);
  });

  it("frees slots as request stamps exit the sliding window", () => {
    const { budget, advance } = makeBudget(2, 1000);
    budget.tryConsume();
    advance(600);
    budget.tryConsume();
    expect(budget.tryConsume()).toBe(false);
    advance(500); // first stamp is now 1100ms old — outside the window
    expect(budget.remaining).toBe(1);
    expect(budget.tryConsume()).toBe(true);
    expect(budget.tryConsume()).toBe(false);
  });

  it("reports retryAfterMs from the oldest stamp when exhausted", () => {
    const { budget, advance } = makeBudget(2, 1000);
    budget.tryConsume();
    advance(300);
    budget.tryConsume();
    expect(budget.retryAfterMs()).toBe(700);
    advance(200);
    expect(budget.retryAfterMs()).toBe(500);
    advance(500);
    expect(budget.retryAfterMs()).toBe(0);
  });

  it("defaults to the 170/hour soft cap", () => {
    const budget = new CharacterDataBudget();
    expect(budget.remaining).toBe(170);
  });

  it("a denied attempt does not consume or extend the window", () => {
    const { budget, advance } = makeBudget(1, 1000);
    budget.tryConsume();
    expect(budget.tryConsume()).toBe(false);
    expect(budget.tryConsume()).toBe(false);
    advance(1001);
    expect(budget.tryConsume()).toBe(true);
  });
});
