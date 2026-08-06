// Things the bundle is not allowed to contain (MP3 §7, WP §6). All of them
// are decisions rather than omissions, which is exactly why they need a guard:
// nothing breaks when someone adds one, so nothing but a test will notice it
// went in.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { APP_NAME } from "@emberchat/protocol";
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

/**
 * The two files Web Push is allowed to add, and nothing else (web-push.md §4).
 * Named by exact path rather than by pattern on purpose: the exception is one
 * worker and one module that registers it, so a second of either — a caching
 * worker, a stray `navigator.serviceWorker` call in a component — still fails
 * both guards below exactly as it did before WP.
 */
const PUSH_WORKER = resolve("public/sw.js");
const PUSH_REGISTRATION = resolve("src/lib/push.ts");

describe("no service worker beyond push (MP3 §7, WP §6)", () => {
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
  //
  // Web Push (design/web-push.md) narrowed that from "none" to "one, and only
  // for the display of push notifications", because no engine will deliver a
  // push to a page — a worker is the only receiver there is. Everything the
  // original decision was actually about is untouched and is now asserted
  // directly, in the third test below.
  it("is registered anywhere but the push module", () => {
    const offenders = sources()
      .filter(([path]) => path !== PUSH_REGISTRATION)
      .flatMap(([path, source]) => {
        const code = uncommented(source);
        return [
          ...code.matchAll(/serviceworker|service-worker|workbox/giu),
        ].map(
          (match) =>
            `${path}:${String(lineOf(code, match.index))}: ${match[0]}`,
        );
      });
    expect(offenders).toEqual([]);
  });

  // A worker also has to be *served* from the origin to claim a scope, so the
  // file sitting in public/ is half of shipping one even with no registration
  // call anywhere near it.
  it("sits on disk under public/ or src/ beyond the push worker", () => {
    const offenders = [resolve("public"), resolve("src")]
      .filter((root) => existsSync(root))
      .flatMap((root) => workerScripts(root))
      .filter((path) => path !== PUSH_WORKER);
    expect(offenders).toEqual([]);
  });

  // The teeth. The push worker exists to call `showNotification` and to route
  // the click; the moment it also answers a `fetch` it becomes the thing MP3
  // refused — a layer that serves the app from disk, before the socket gets a
  // word in, for as long as it stays registered. `fetch` is banned outright
  // rather than only as an event name: a worker with no cache and no offline
  // story has no reason to make requests either, and the narrower rule would
  // pass `caches.open` reached through a plain fetch wrapper.
  it("keeps the push worker to display and click routing", () => {
    expect(existsSync(PUSH_WORKER)).toBe(true);
    const code = uncommented(readFileSync(PUSH_WORKER, "utf8"));
    const offenders = [
      ...code.matchAll(/\bfetch\b|\bcaches\b|CacheStorage/giu),
    ].map((match) => `sw.js:${String(lineOf(code, match.index))}: ${match[0]}`);
    expect(offenders).toEqual([]);
  });
});

describe("the product name (MP3 §7, #556)", () => {
  // "EmberChat" is the product's final name (decisions.md §5), and it has
  // exactly one home: `APP_NAME` in @emberchat/protocol. It was a config token
  // before, for a self-hoster who might have renamed the product; it is a
  // constant now, and the guard is the same guard for a different reason — a
  // name spelled out in twelve components is a name that gets half-renamed,
  // half-capitalised and quietly wrong in the sentences that matter (the ones
  // about where a user's data lives, #378).
  //
  // Two shapes are allowed through:
  //
  //  - `@emberchat/…` — workspace package specifiers, including the import of
  //    the constant itself. These are module identity, never rendered.
  //  - the lowercase dotted namespace `emberchat.<something>` — localStorage
  //    keys and one `Symbol.for`, currently `emberchat.composeMarkdown`,
  //    `emberchat.sidebarOrder` (legacy, still read for migration),
  //    `emberchat.sidebarCollapsed`, `emberchat.searchRun.<id>`,
  //    `emberchat.lastIdentityId`, `emberchat.pushEnabled` and
  //    `emberchat.longpress.claimed`. They are persisted keys: renaming them
  //    with the product would orphan every user's saved state on upgrade, so
  //    they are frozen on purpose.
  it("is imported, never spelled out", () => {
    const offenders = sources().flatMap(([path, source]) => {
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

  // The one deliberate literal: index.html titles the document before any
  // module of ours exists to do it, so the tab would otherwise read something
  // else for the length of a boot. Same arrangement as the theme-color meta
  // (theme-color.test.ts) — a literal in the markup, and a test that fails the
  // moment it stops agreeing with the constant.
  it("titles the document with the constant's own spelling", () => {
    const html = readFileSync(resolve("index.html"), "utf8");
    expect(/<title>([^<]*)<\/title>/u.exec(html)?.[1]).toBe(APP_NAME);
  });
});
