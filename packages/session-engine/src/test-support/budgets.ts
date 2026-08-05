/**
 * Timeout budgets shared by the engine's own suites and the server's.
 *
 * These two tiers live here rather than in `apps/server/src/test-support`
 * because the engine's sim-backed tests moved into this package and the
 * server's still need the same numbers — `@emberchat/server`'s budgets module
 * re-exports them, so there is one source of truth on both sides of the
 * boundary. The server keeps the tiers only it uses (testcontainers boot,
 * argon2/CLI work) next to that re-export.
 *
 * The rule the constants exist to enforce: **a wait helper's default deadline
 * must be ≥ its file's `testTimeout` tier.** An inner deadline below the outer
 * budget makes the outer budget inert — the helper rejects first, so raising
 * `vi.setConfig({ testTimeout })` buys nothing. That is exactly how the earlier
 * flake fixes (#404, #425) ended up partially neutralized.
 */

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
 * One wire frame, or one status transition, over loopback. Matches
 * `INTEGRATION_MS` by design: a helper deadline shorter than the enclosing
 * test budget is the defect this module exists to prevent.
 */
export const FRAME_WAIT_MS = 15_000;
