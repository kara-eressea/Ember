// The regression this guards: a browser loading the schemas used to trip zod's
// `new Function` probe, which the SPA's CSP reports as a violation in every
// user's console. Asserting `config().jitless` would not catch the real failure
// mode (the flag being set too late, after a schema was already built), so trap
// the constructor instead and require that nothing probed it.

import { expect, it, vi } from "vitest";

it("builds every schema without probing new Function in a browser", async () => {
  vi.stubGlobal("document", {});
  const probes: unknown[] = [];
  const target = globalThis.Function;
  vi.stubGlobal(
    "Function",
    new Proxy(target, {
      construct: (fn, args, newTarget) => {
        probes.push(args[0]);
        return Reflect.construct(fn, args, newTarget) as object;
      },
      apply: (fn, thisArg, args) => {
        probes.push(args[0]);
        return Reflect.apply(fn, thisArg, args) as unknown;
      },
    }),
  );

  await import("./index.js");

  expect(probes).toEqual([]);
});
