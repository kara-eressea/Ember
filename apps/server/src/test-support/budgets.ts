/**
 * Timeout budgets for the server test suites.
 *
 * The rule these constants exist to enforce: **a wait helper's default
 * deadline must be ≥ its file's `testTimeout` tier.** An inner deadline below
 * the outer budget makes the outer budget inert — the helper rejects first, so
 * raising `vi.setConfig({ testTimeout })` buys nothing. That is exactly how the
 * earlier flake fixes (#404, #425) ended up partially neutralized: files moved
 * to 15–30s budgets while their `waitFor*` helpers kept vitest-default-era 5s
 * defaults.
 *
 * Cost of the policy: a genuinely-failing wait now burns its full budget before
 * reporting. That is accepted — a slow honest failure beats a fast false one.
 *
 * Deliberate exceptions stay legal: a call site that asserts a wait *times out*
 * (a negative assertion — "no error frame arrives") must pass its own short
 * timeout explicitly, and should say why.
 *
 * One place these constants deliberately do not reach: the positional
 * `it(name, fn, 30_000)` per-test form. Prettier only recognizes it as a test
 * call while the timeout is a numeric literal — swap in an identifier and it
 * re-indents the whole test body. Those sites keep their literals.
 */

/** `beforeAll` that boots a testcontainers Postgres — image pull included. */
export const CONTAINER_BOOT_MS = 180_000;

/**
 * Per-test budget for a container- or sim-backed file: several DB round trips
 * and some loopback WebSocket traffic per test.
 */
export const INTEGRATION_MS = 15_000;

/**
 * Files (or single tests) that chain noticeably more work — multi-step API +
 * sim sequences, cache warm-ups, paged fetches, a reconnect inside the test.
 * Deliberately above `INTEGRATION_MS`; not a default to reach for.
 */
export const INTEGRATION_SLOW_MS = 20_000;

/**
 * Work that competes with the rest of the suite for a loaded runner: argon2
 * hashing, CLI child processes, reconnect-backoff waits. The #404 precedent —
 * these fail on CI at any smaller budget and are fast locally either way.
 */
export const LOADED_RUNNER_MS = 30_000;

/**
 * One wire frame, or one status transition, over loopback. Matches
 * `INTEGRATION_MS` by design: a helper deadline shorter than the enclosing
 * test budget is the defect this module exists to prevent.
 */
export const FRAME_WAIT_MS = 15_000;
