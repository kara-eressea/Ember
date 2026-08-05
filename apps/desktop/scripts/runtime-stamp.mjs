/**
 * The server-runtime cache decision, kept pure so it can be unit-tested
 * without deploying anything (src/runtime-stamp.test.ts). The rebuild it
 * guards costs ~90 seconds; the inputs that can invalidate it are few and
 * cheap to read.
 *
 * @typedef {object} RuntimeStamp
 * @property {number} serverBuiltAtMs Newest mtime across the server's shipped
 *   inputs (dist, drizzle migrations, manifest).
 * @property {string} electronVersion The ABI the native modules were built
 *   against.
 * @property {string} pgliteSpec The version range installed into the tree.
 */

/**
 * @param {unknown} value
 * @returns {RuntimeStamp | undefined} The stamp, or undefined if the file is
 *   missing, truncated or from an older shape — all of which mean "rebuild".
 */
export function parseStamp(value) {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const candidate = /** @type {Partial<RuntimeStamp>} */ (value);
  if (
    typeof candidate.serverBuiltAtMs !== "number" ||
    typeof candidate.electronVersion !== "string" ||
    typeof candidate.pgliteSpec !== "string"
  ) {
    return undefined;
  }
  return {
    serverBuiltAtMs: candidate.serverBuiltAtMs,
    electronVersion: candidate.electronVersion,
    pgliteSpec: candidate.pgliteSpec,
  };
}

/**
 * Why a given field went stale, in the order a human would want to hear it.
 *
 * @type {{ key: keyof RuntimeStamp, reason: string }[]}
 */
const FIELDS = [
  { key: "serverBuiltAtMs", reason: "the server build changed" },
  { key: "electronVersion", reason: "the Electron version changed" },
  { key: "pgliteSpec", reason: "the pglite version changed" },
];

/**
 * @param {object} input
 * @param {boolean} input.runtimePresent Whether the built tree is actually
 *   on disk — a stamp without a tree (or a tree someone deleted) is nothing.
 * @param {RuntimeStamp | undefined} input.previous
 * @param {RuntimeStamp} input.next
 * @returns {{ stale: boolean, reason: string }}
 */
export function runtimeBuildDecision({ runtimePresent, previous, next }) {
  if (!runtimePresent) {
    return { stale: true, reason: "no server-runtime tree yet" };
  }
  if (previous === undefined) {
    return {
      stale: true,
      reason: "no usable stamp file for the existing tree",
    };
  }
  const changed = FIELDS.filter(({ key }) => previous[key] !== next[key]);
  if (changed.length > 0) {
    return {
      stale: true,
      reason: changed.map(({ reason }) => reason).join(", "),
    };
  }
  return { stale: false, reason: "up to date" };
}
