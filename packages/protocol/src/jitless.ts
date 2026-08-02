// Zod JIT-compiles object parsers with `new Function`, probing once for it
// when the first object schema is constructed. In a browser that probe is a
// guaranteed CSP violation — the SPA is served under `script-src 'self'` with
// no 'unsafe-eval' (apps/server/src/security/csp.ts) — and while the throw is
// caught and zod falls back to the interpreted path, every user still gets a
// red console error on load. `jitless` skips the probe entirely; Node (the
// bouncer, where nothing forbids eval) keeps the JIT.
//
// Imported first by index.ts so it runs before any schema module is evaluated;
// `jitless.test.ts` fails if that ordering is ever lost.

import { config } from "zod";

// `"document" in globalThis` rather than `typeof document`: this package is
// built without the DOM lib.
if ("document" in globalThis) {
  config({ jitless: true });
}
