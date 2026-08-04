// Two things the bundle is not allowed to contain (MP3 §7). Both are
// decisions rather than omissions, which is exactly why they need a guard:
// nothing breaks when someone adds either one, so nothing but a test will
// notice it went in.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/** Every source file the app ships, as `[path, text]`. Tests excluded. */
function sources(dir = resolve("src")): [string, string][] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      return sources(path);
    }
    if (!/\.tsx?$/u.test(entry.name) || /\.test\./u.test(entry.name)) {
      return [];
    }
    return [[path, readFileSync(path, "utf8")]] as [string, string][];
  });
}

/**
 * `source` with its comments blanked out, newlines kept so line numbers still
 * line up.
 *
 * The line-comment pass refuses to fire on `://` so that a URL in a string
 * does not swallow the rest of its line. That is a heuristic and not a
 * tokenizer: a literal `//` inside a string, in the middle of a line, still
 * blanks what follows it. The trade is deliberate — the alternative is
 * counting quotes across template literals and regex literals, and the only
 * thing at stake is a guard whose whole subject is what the code says out
 * loud.
 */
function uncommented(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//gu, (block) => block.replace(/[^\n]/gu, " "))
    .replace(/(^|[^:])\/\/[^\n]*/gmu, "$1");
}

/** 1-based line number of `index` in `text`. */
function lineOf(text: string, index: number): number {
  return text.slice(0, index).split("\n").length;
}

/** Any file under `dir` whose name is a service worker's conventional one. */
function workerScripts(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      return workerScripts(path);
    }
    return /^(?:sw\.js|service-worker)/u.test(entry.name) ? [path] : [];
  });
}

describe("no service worker (MP3 §7)", () => {
  // The absence is the design (mp3-pwa.md's preamble), not a corner nobody
  // got to. The client is a live view onto a bouncer that holds the real
  // session: what it renders is only ever true because a socket said so a
  // moment ago. A cache underneath that answers with yesterday's messages,
  // yesterday's member list, yesterday's version of the app — and it answers
  // *first*, before the socket gets a word in. The failure is not "stale for
  // a second", it is a user reading a conversation that has moved on and not
  // being able to tell. A service worker is also the one thing here that
  // outlives its own deployment: it keeps serving from disk after the tab
  // that installed it is gone, so shipping one by accident is a bug that
  // cannot be fixed by shipping a fix.
  it("is registered anywhere in the client", () => {
    const offenders = sources().flatMap(([path, source]) => {
      const code = uncommented(source);
      return [...code.matchAll(/serviceworker|service-worker|workbox/giu)].map(
        (match) => `${path}:${String(lineOf(code, match.index))}: ${match[0]}`,
      );
    });
    expect(offenders).toEqual([]);
  });

  // A worker also has to be *served* from the origin to claim a scope, so the
  // file sitting in public/ is half of shipping one even with no registration
  // call anywhere near it.
  it("sits on disk under public/ or src/ either", () => {
    const offenders = [resolve("public"), resolve("src")]
      .filter((root) => existsSync(root))
      .flatMap((root) => workerScripts(root));
    expect(offenders).toEqual([]);
  });
});

describe("the product name (MP3 §7)", () => {
  // "EmberChat" is a working title and every instance is somebody's
  // self-host, so the name belongs to the runtime config and not to the
  // build. A literal in a component is a sentence that goes on saying
  // "EmberChat" to a user whose server is called something else — and the
  // sentences it tends to appear in are the ones about where their data
  // lives, which is precisely where being wrong costs trust (#378).
  //
  // Three shapes are allowed through:
  //
  //  - `@emberchat/…` — workspace package specifiers. These are module
  //    identity, never rendered.
  //  - the lowercase dotted namespace `emberchat.<something>` — localStorage
  //    keys and one `Symbol.for`, currently `emberchat.composeMarkdown`,
  //    `emberchat.sidebarOrder` (legacy, still read for migration),
  //    `emberchat.sidebarCollapsed`, `emberchat.searchRun.<id>`,
  //    `emberchat.lastIdentityId` and `emberchat.longpress.claimed`. They are
  //    persisted keys: renaming them with the product would orphan every
  //    user's saved state on upgrade, so they are frozen on purpose.
  //  - `lib/config.ts`, which owns the working title as its documented
  //    fallback for when the server injects no config at all.
  it("is a config token everywhere it is shown", () => {
    const fallbackHome = resolve("src/lib/config.ts");
    const offenders = sources()
      .filter(([path]) => path !== fallbackHome)
      .flatMap(([path, source]) => {
        const code = uncommented(source);
        return [...code.matchAll(/emberchat/giu)]
          .filter((match) => {
            const before = code[match.index - 1];
            const after = code[match.index + match[0].length];
            const isPackage = before === "@";
            const isNamespace = match[0] === "emberchat" && after === ".";
            return !isPackage && !isNamespace;
          })
          .map((match) => {
            const line = lineOf(code, match.index);
            const text = source.split("\n")[line - 1]?.trim() ?? "";
            return `${path}:${String(line)}: ${text}`;
          });
      });
    expect(offenders).toEqual([]);
  });
});
