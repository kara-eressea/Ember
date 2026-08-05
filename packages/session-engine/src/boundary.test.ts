// The library boundary, enforced instead of reviewed for.
//
// design/standalone-client.md fixes this package's dependencies at: `ws`, the
// node stdlib, `@emberchat/fchat-protocol` and zod — no Fastify, no pino (the
// logger is the structural `SessionLogger`), no Drizzle, no config module. All
// I/O is injected or event-bus-inverted, which is what lets the same engine
// drive the Fastify bouncer and the embedded desktop one. The design doc's
// standing rule was "flagged in review"; this walk makes it fail by name.
//
// Two ways the boundary can rot, both checked here:
//
//  1. A bare import of host machinery. `package.json` already refuses to list
//     fastify/drizzle/pino, but a transitive hoist can make such an import
//     resolve anyway, so the allow-list below is the real gate — and being an
//     allow-list rather than a ban-list, a *new* dependency has to be argued
//     for here as well as in the manifest.
//  2. A relative path that climbs out of `src/` — `../../apps/server/...`.
//     That bypasses `package.json` entirely, and is also how a reverse import
//     (engine reaching back into the server) would arrive.

import { readdirSync, readFileSync } from "node:fs";
import { isBuiltin } from "node:module";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SRC_DIR = import.meta.dirname;

/** Everything the engine may import at runtime. Node builtins are allowed on
 * top of this (see `isBuiltin`). */
const ALLOWED_RUNTIME = new Set(["ws", "zod", "@emberchat/fchat-protocol"]);

/** Additionally allowed in `*.test.ts` — the runner and the protocol sim the
 * engine's suites drive instead of the live F-Chat server. */
const ALLOWED_IN_TESTS = new Set(["vitest", "@emberchat/fchat-sim"]);

/**
 * `import … from "x";` / `export … from "x";`, including the multi-line brace
 * form. Anchored to the start of a line, so prose inside a test name ("…
 * reconnects from a dropped socket…") is not an import; and no `;` may fall
 * between the keyword and its `from`, so an `export class` whose body happens
 * to contain a string literal is not one either.
 */
const FROM_RE = /^(?:import|export)\b[^;]*?\bfrom\s*["']([^"']+)["'];/gm;

/** Side-effect `import "x";`. */
const BARE_RE = /^import\s+["']([^"']+)["'];/gm;

/** Dynamic `import()` of a literal specifier — unambiguous enough to match
 * anywhere, including mid-expression. */
const DYNAMIC_RE = /\bimport\(\s*["']([^"']+)["']\s*\)/g;

function sourceFiles(): string[] {
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return walk(path);
      return entry.name.endsWith(".ts") ? [path] : [];
    });
  return walk(SRC_DIR).sort();
}

function specifiers(source: string): string[] {
  return [
    ...source.matchAll(FROM_RE),
    ...source.matchAll(BARE_RE),
    ...source.matchAll(DYNAMIC_RE),
  ].map((match) => match[1]!);
}

/** The importable package name of a bare specifier: `@scope/name` or `name`,
 * subpath discarded (`@emberchat/fchat-sim/foo` → `@emberchat/fchat-sim`). */
function packageName(specifier: string): string {
  const parts = specifier.split("/");
  return specifier.startsWith("@")
    ? parts.slice(0, 2).join("/")
    : (parts[0] ?? specifier);
}

/** Throws naming the offender if `specifier`, imported by `file`, leaves the
 * boundary — either a bare import outside the allow-list or a relative path
 * climbing out of `src/`. */
function assertInsideBoundary(file: string, specifier: string): void {
  const name = relative(SRC_DIR, file);
  if (specifier.startsWith(".")) {
    const target = resolve(file, "..", specifier);
    expect(
      relative(SRC_DIR, target).startsWith(".."),
      `${name} imports "${specifier}", which escapes the package — the session engine may not reach into apps/server or any sibling package by path`,
    ).toBe(false);
    return;
  }
  if (isBuiltin(specifier)) return;
  const allowed = new Set(ALLOWED_RUNTIME);
  if (name.endsWith(".test.ts")) {
    for (const extra of ALLOWED_IN_TESTS) allowed.add(extra);
  }
  expect(
    allowed.has(packageName(specifier)),
    `${name} imports "${specifier}" — the session engine's dependencies are fixed at ${[...allowed].join(", ")} plus node builtins (design/standalone-client.md). Inject the capability at the boundary instead of importing host machinery.`,
  ).toBe(true);
}

describe("session-engine boundary", () => {
  const files = sourceFiles();

  it("walks every source file in the package", () => {
    // A broken walk, or an extractor that matches nothing, would make every
    // assertion below vacuously green.
    expect(files.length).toBeGreaterThan(10);
    const session = specifiers(
      readFileSync(join(SRC_DIR, "fchat-session.ts"), "utf8"),
    );
    expect(session).toContain("ws");
    expect(session).toContain("@emberchat/fchat-protocol");
    expect(session).toContain("./rate-gate.js");
  });

  it("reads specifiers from statements, not from prose", () => {
    expect(
      specifiers(
        [
          'import { A } from "./a.js";',
          "import type {",
          "  B,",
          '} from "./b.js";',
          'export * from "./c.js";',
          'it("reconnects from a dropped socket", () => {});',
          'const doc = "see ../../apps/server/src/app.ts";',
          "export class FlistAuthError extends Error {",
          '  readonly name = "FlistAuthError";',
          "}",
        ].join("\n"),
      ),
    ).toEqual(["./a.js", "./b.js", "./c.js"]);
  });

  it.each(files.map((file) => [relative(SRC_DIR, file), file]))(
    "%s imports nothing outside the boundary",
    (_name, file) => {
      for (const specifier of specifiers(readFileSync(file, "utf8"))) {
        assertInsideBoundary(file, specifier);
      }
    },
  );

  it("fails a host-machinery import", () => {
    // The regressions the walk exists to catch, proven against stand-ins.
    for (const specifier of [
      "fastify",
      "@fastify/websocket",
      "drizzle-orm",
      "pino",
      "pg",
      "../../db/index.js",
      "../../../apps/server/src/config.js",
    ]) {
      expect(() =>
        assertInsideBoundary(join(SRC_DIR, "fchat-session.ts"), specifier),
      ).toThrow();
    }
  });

  it("allows the dependencies the design fixes", () => {
    for (const specifier of [
      "ws",
      "zod",
      "node:crypto",
      "@emberchat/fchat-protocol",
      "./session-state.js",
      "./test-support/budgets.js",
    ]) {
      expect(() =>
        assertInsideBoundary(join(SRC_DIR, "fchat-session.ts"), specifier),
      ).not.toThrow();
    }
    expect(() =>
      assertInsideBoundary(join(SRC_DIR, "registry.test.ts"), "vitest"),
    ).not.toThrow();
    // …and only in tests.
    expect(() =>
      assertInsideBoundary(join(SRC_DIR, "registry.ts"), "vitest"),
    ).toThrow();
  });
});
