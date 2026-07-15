import { describe, expect, it } from "vitest";
import { compileRule, HighlightMatcher } from "./matcher.js";

describe("compileRule", () => {
  it("word rules match at ASCII word boundaries, case-insensitively", () => {
    const rule = compileRule("word", "vale");
    expect(rule.test("hello Vale!")).toBe(true);
    expect(rule.test("VALE")).toBe(true);
    expect(rule.test("the vale of shadows")).toBe(true);
    // Boundary: never inside a longer word.
    expect(rule.test("Valery waves")).toBe(false);
    expect(rule.test("unveiled")).toBe(false);
    expect(rule.test("vale_of")).toBe(false);
  });

  it("multi-word and hyphenated terms keep their boundaries", () => {
    const name = compileRule("nick", "Amber Vale");
    expect(name.test("ping Amber Vale, you around?")).toBe(true);
    expect(name.test("amber vale?")).toBe(true);
    expect(name.test("Amber Valery sends regards")).toBe(false);

    // Leading/trailing hyphens have no \b boundary at all — the explicit
    // classes are why we don't use \b.
    const hyphen = compileRule("nick", "-Night-Blade-");
    expect(hyphen.test("hey -Night-Blade- !")).toBe(true);
    expect(hyphen.test("start: -Night-Blade-")).toBe(true);
  });

  it("word terms are literal — regex metacharacters do not activate", () => {
    const rule = compileRule("word", "1+1");
    expect(rule.test("what is 1+1 ?")).toBe(true);
    expect(rule.test("what is 11 ?")).toBe(false);
  });

  it("regex rules run as written, case-insensitively, unwrapped", () => {
    const rule = compileRule("regex", "drag+on");
    expect(rule.test("a DRAGGGON appears")).toBe(true);
    // No boundary wrap: inside a longer word is a match.
    expect(rule.test("dragonfly")).toBe(true);
  });

  it("throws on patterns RE2 refuses (backtracking-only features)", () => {
    expect(() => compileRule("regex", "(?<=x)y")).toThrow(); // lookbehind
    expect(() => compileRule("regex", "(a")).toThrow(); // unbalanced
    expect(() => compileRule("regex", "(a)\\1")).toThrow(); // backreference
  });

  it("classic catastrophic-backtracking patterns run in linear time", () => {
    // On a backtracking engine this pattern vs this input is seconds-to-
    // forever; RE2 answers immediately — the property the whole design
    // leans on (decisions.md §10).
    const rule = compileRule("regex", "(a+)+$");
    const input = "a".repeat(50_000) + "b";
    const started = Date.now();
    expect(rule.test(input)).toBe(false);
    expect(Date.now() - started).toBeLessThan(200);
  });
});

describe("HighlightMatcher cache invalidation race", () => {
  it("a rules load racing invalidate() must not populate the cache", async () => {
    // Interleaving under test: message → cache miss → SELECT begins (sees
    // the pre-PUT rows) → PUT commits and invalidates (no-op delete — the
    // entry does not exist yet) → SELECT resolves. Without the generation
    // guard the stale snapshot would be cached and every later message
    // matched against pre-PUT rules — permanently wrong (immutable)
    // mention verdicts.
    const user = "user-1";
    let releaseRules!: (rows: { kind: string; pattern: string }[]) => void;
    let rulesQueried!: () => void;
    const queried = new Promise<void>((resolve) => (rulesQueried = resolve));
    const queue: (() => Promise<unknown[]>)[] = [
      // mention #1: identity → user lookup, own-nick prefs, rules (deferred)
      () => Promise.resolve([{ userId: user }]),
      () => Promise.resolve([{ prefs: { highlightOwnNick: false } }]),
      () => {
        rulesQueried();
        return new Promise((resolve) => (releaseRules = resolve));
      },
      // mention #2 after the invalidation: own-nick + rules re-query
      () => Promise.resolve([{ prefs: { highlightOwnNick: false } }]),
      () => Promise.resolve([{ kind: "word", pattern: "fresh" }]),
    ];
    let index = 0;
    const builder = (result: Promise<unknown[]>) => {
      const chain = {
        from: () => chain,
        innerJoin: () => chain,
        where: () => chain,
        limit: () => result,
        then: (
          onFulfilled?: (rows: unknown[]) => unknown,
          onRejected?: (error: unknown) => unknown,
        ) => result.then(onFulfilled, onRejected),
      };
      return chain;
    };
    const fakeDb = {
      select: () => builder(queue[index++]!()),
    } as unknown as ConstructorParameters<typeof HighlightMatcher>[0];

    const matcher = new HighlightMatcher(fakeDb);
    const first = matcher.mention("identity-1", "Amber Vale", "old term here");
    await queried; // the load recorded its generation and is now in flight
    matcher.invalidate(user); // the PUT lands mid-load
    releaseRules([{ kind: "word", pattern: "old" }]);
    // The in-flight call answers from the snapshot it read — acceptable.
    expect(await first).toBe(true);
    // But the NEXT message must re-query and see the fresh rules.
    expect(
      await matcher.mention("identity-1", "Amber Vale", "fresh paint"),
    ).toBe(true);
    expect(await matcher.mention("identity-1", "Amber Vale", "old term")).toBe(
      false,
    );
    expect(index).toBe(5); // exactly one re-query pair, then cache hits
  });
});
