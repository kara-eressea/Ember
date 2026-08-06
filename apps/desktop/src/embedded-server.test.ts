/**
 * The embedded bouncer's lifecycle, driven by fakes — no Electron, no server,
 * no socket. What is under test is the decision table `embedded-server.ts`
 * carries and the packaged smoke test can only ever walk one path of: which
 * failures earn another port, which do not, and whether `stop()` tells the
 * truth about a child that would not go.
 *
 * The seam is `ServerRuntime` — `fork`, `findFreePort` and `fetch` all come in
 * from outside, so a "child" here is an object that exits when the test says
 * so and a "server" is a `fetch` that answers.
 */

import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  EmbeddedServerStartError,
  nodeChildLaunch,
  serverChildMechanism,
  startEmbeddedServer,
  stopChildOnExit,
  type ServerChild,
  type ServerRuntime,
  type StartEmbeddedServerOptions,
} from "./embedded-server.js";
import { buildServerEnv } from "./server-env.js";

const OPTIONS: StartEmbeddedServerOptions = {
  entry: "/resources/server-runtime/dist/main.js",
  dataDir: "/user-data/db",
  webDist: "/resources/web",
  authSecret: "an-auth-secret",
  clientVersion: "1.2.3",
  // Every case below either has a child that is already gone or a `fetch` that
  // never answers, so this is only ever the wait before the verdict.
  readyTimeoutMs: 200,
};

/**
 * A child process the test drives. `deadOnArrival` is the case the retry loop
 * exists for: by the time the lifecycle looks, the child has already exited —
 * so the exit is delivered the moment the listener is registered, which is
 * also what keeps these tests instant.
 */
class FakeChild implements ServerChild {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  kills = 0;
  /** Whether a `kill()` actually ends this child, or it hangs on (the pglite
   * case `stop()`'s boolean is about). */
  killEnds = true;
  #listener: ((code: number | null) => void) | undefined;
  #exited = false;

  constructor(
    private readonly deadOnArrival?: number | null,
    said?: { out?: string; err?: string },
  ) {
    // Buffered until the lifecycle attaches its `data` handlers.
    if (said?.out !== undefined) {
      this.stdout.write(said.out);
    }
    if (said?.err !== undefined) {
      this.stderr.write(said.err);
    }
  }

  once(event: "exit", listener: (code: number | null) => void): this {
    this.#listener = listener;
    if (this.deadOnArrival !== undefined) {
      this.exit(this.deadOnArrival);
    }
    return this;
  }

  exit(code: number | null): void {
    if (this.#exited) {
      return;
    }
    this.#exited = true;
    this.#listener?.(code);
  }

  kill(): boolean {
    this.kills += 1;
    if (this.killEnds) {
      // A tick later, never in the caller's stack: a signal is delivered by
      // the OS and neither `utilityProcess.kill()` nor `ChildProcess.kill()`
      // has produced the `exit` event by the time they return. The lifecycle
      // reads `exitCode` right after killing a child it gave up on, so a fake
      // that exited synchronously would be answering a question nothing can
      // ask in production.
      setTimeout(() => {
        this.exit(0);
      }, 0);
    }
    return true;
  }
}

/** A `/healthz` that answers, and the URLs it was asked for. */
function respondingFetch(urls: string[] = []): {
  fetch: typeof globalThis.fetch;
  urls: string[];
} {
  return {
    urls,
    fetch: (input: unknown) => {
      urls.push(String(input));
      return Promise.resolve(new Response(null, { status: 200 }));
    },
  };
}

/** Connection refused, forever — a child that is up and saying nothing. */
const silentFetch = (() =>
  Promise.reject(new Error("ECONNREFUSED"))) as typeof globalThis.fetch;

/** Ports handed out in order, so "a fresh port each time" is observable. */
function ports(...values: number[]): () => Promise<number> {
  let index = 0;
  return () => Promise.resolve(values[index++] ?? 0);
}

/** Starts a boot that is expected to fail, and hands back the refusal. */
async function bootFailure(
  deps: ServerRuntime,
  options: StartEmbeddedServerOptions = OPTIONS,
): Promise<EmbeddedServerStartError> {
  try {
    await startEmbeddedServer(options, deps);
  } catch (error) {
    if (error instanceof EmbeddedServerStartError) {
      return error;
    }
    throw error;
  }
  throw new Error("the boot was expected to fail and did not");
}

function runtime(overrides: Partial<ServerRuntime> = {}): ServerRuntime {
  return {
    fork: () => new FakeChild(),
    findFreePort: ports(41001, 41002, 41003),
    fetch: silentFetch,
    ...overrides,
  };
}

beforeEach(() => {
  // The lifecycle mirrors the child's output onto this process's streams; the
  // tests that make a child talk should not make the test run talk.
  vi.spyOn(process.stderr, "write").mockReturnValue(true);
  vi.spyOn(process.stdout, "write").mockReturnValue(true);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("a child that dies before it is ready", () => {
  it("is retried on a fresh port, three times, and then reported", async () => {
    const drawn: number[] = [];
    const forked: string[] = [];
    // The third one ends on a signal, which a spawned child reports as a null
    // code — the `?? -1` convention the message has to survive.
    const codes = [1, 1, null];
    let attempt = 0;
    const failure = await bootFailure(
      runtime({
        findFreePort: () => {
          const port = 41000 + drawn.length + 1;
          drawn.push(port);
          return Promise.resolve(port);
        },
        fork: (entry) => {
          forked.push(entry);
          return new FakeChild(codes[attempt++]);
        },
      }),
    );

    expect(forked).toEqual([OPTIONS.entry, OPTIONS.entry, OPTIONS.entry]);
    // Not the same port three times: the whole point of the retry (MX4's
    // Windows finding) is that the *port* is what might be unusable.
    expect(drawn).toEqual([41001, 41002, 41003]);
    expect(new Set(drawn).size).toBe(3);
    expect(failure.childExited).toBe(true);
    expect(failure.message).toContain("stopped while it was starting");
    expect(failure.message).toContain("exited with code -1");
    // Two warnings, not three: the last attempt is a failure, not a retry.
    expect(console.warn).toHaveBeenCalledTimes(2);
    expect(vi.mocked(console.warn).mock.calls[0]?.[0]).toContain(
      "attempt 1 of 3",
    );
  });

  it("stops retrying the moment one comes up", async () => {
    let attempt = 0;
    const { fetch, urls } = respondingFetch();
    const server = await startEmbeddedServer(
      OPTIONS,
      runtime({
        fork: () => (attempt++ === 0 ? new FakeChild(1) : new FakeChild()),
        fetch,
      }),
    );

    expect(attempt).toBe(2);
    // The second port is the one the app then talks to — a retry that reported
    // the first port's origin would send the window somewhere with nothing on it.
    expect(server.port).toBe(41002);
    expect(server.origin).toBe("http://127.0.0.1:41002");
    expect(urls).toEqual(["http://127.0.0.1:41002/healthz"]);
  });
});

describe("a child that is alive and never answers", () => {
  it("is given up on after one attempt, and killed", async () => {
    const child = new FakeChild();
    let forks = 0;
    const failure = await bootFailure(
      runtime({
        fork: () => {
          forks += 1;
          return child;
        },
      }),
    );

    // Another port would cost three times the ready timeout to learn the same
    // thing, so the predicate is `childExited` and not "the boot failed".
    expect(forks).toBe(1);
    expect(failure.childExited).toBe(false);
    expect(failure.message).toContain("didn't finish starting in time");
    expect(failure.message).toContain("http://127.0.0.1:41001");
    // Nothing is left holding the data directory.
    expect(child.kills).toBe(1);
    expect(console.warn).not.toHaveBeenCalled();
  });

  it("hands the crash dialog the tail of what the child said", async () => {
    const failure = await bootFailure(
      runtime({
        fork: () =>
          new FakeChild(undefined, {
            // Both streams: a bouncer that cannot open its database says so on
            // stdout through its own logger, and the crash dialog is the only
            // place a packaged user will ever see either.
            out: `${"x".repeat(9_000)}\nlistening on 127.0.0.1\n`,
            err: "Error: PGLITE_DATA_DIR is not writable\n",
          }),
      }),
    );

    expect(failure.childStderr).toContain("PGLITE_DATA_DIR is not writable");
    expect(failure.childStderr).toContain("listening on 127.0.0.1");
    // Capped, and it is the *tail* that is kept — the reason is at the end.
    expect(failure.childStderr.length).toBeLessThanOrEqual(8_000);
    expect(failure.childStderr).not.toContain("x".repeat(8_000));
  });
});

describe("the environment the child is given", () => {
  it("is exactly the server's own, for the port that was drawn", async () => {
    // A shell environment that must not reach the bouncer (server-env.ts).
    vi.stubEnv("DATABASE_URL", "postgres://somewhere/else");
    let given: Record<string, string> | undefined;
    const { fetch } = respondingFetch();
    await startEmbeddedServer(
      OPTIONS,
      runtime({
        fork: (_entry, env) => {
          given = env;
          return new FakeChild();
        },
        fetch,
      }),
    );

    expect(given).toEqual(
      buildServerEnv({
        port: 41001,
        dataDir: OPTIONS.dataDir,
        webDist: OPTIONS.webDist,
        authSecret: OPTIONS.authSecret,
        clientVersion: OPTIONS.clientVersion,
      }),
    );
    // Named individually because `toEqual` above would still pass if
    // buildServerEnv itself started leaking: these are the four that decide
    // which database is opened and which origin may reach the gateway.
    expect(given).toMatchObject({
      DB_DRIVER: "pglite",
      PGLITE_DATA_DIR: OPTIONS.dataDir,
      PORT: "41001",
      APP_BASE_URL: "http://127.0.0.1:41001",
    });
    expect(given).not.toHaveProperty("DATABASE_URL");
  });
});

describe("stop()", () => {
  const start = async (child: FakeChild) => {
    const { fetch } = respondingFetch();
    return startEmbeddedServer(OPTIONS, runtime({ fork: () => child, fetch }));
  };

  it("confirms a child that goes when it is asked", async () => {
    const child = new FakeChild();
    const server = await start(child);
    await expect(server.stop()).resolves.toBe(true);
    expect(child.kills).toBe(1);
  });

  it("is true and silent for a child that has already gone", async () => {
    const child = new FakeChild();
    const server = await start(child);
    child.exit(0);
    await expect(server.stop()).resolves.toBe(true);
    // No signal to a pid that may since have been reused.
    expect(child.kills).toBe(0);
  });

  it("answers false when the child outlives the grace period", async () => {
    const child = new FakeChild();
    child.killEnds = false;
    const server = await start(child);

    // The grace period on a virtual clock: what matters is that the answer
    // arrives, and that it is the one first-run provisioning refuses to
    // continue past (a second writer on a pglite data directory is corruption).
    vi.useFakeTimers();
    const stopping = server.stop();
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(stopping).resolves.toBe(false);
    expect(child.kills).toBe(1);
  });
});

describe("onUnexpectedExit", () => {
  it("reports the code of a child that dies after it was up", async () => {
    const child = new FakeChild();
    const { fetch } = respondingFetch();
    const server = await startEmbeddedServer(
      OPTIONS,
      runtime({ fork: () => child, fetch }),
    );
    const seen: number[] = [];
    server.onUnexpectedExit((code) => seen.push(code));

    child.exit(137);
    await vi.waitFor(() => {
      expect(seen).toEqual([137]);
    });
  });
});

describe("which kind of child the bouncer runs as", () => {
  it.each([
    ["win32", "node-child"],
    ["darwin", "utility-process"],
    ["linux", "utility-process"],
  ] as const)("%s → %s", (platform, mechanism) => {
    // Windows only: a utility process there cannot open a listening socket
    // (MX4, #305). Everywhere else keeps Electron's own child, which dies with
    // the shell without a backstop.
    expect(serverChildMechanism(platform)).toBe(mechanism);
  });

  it("runs Electron's binary as Node, with the server's own env", () => {
    const env = buildServerEnv({
      port: 41001,
      dataDir: OPTIONS.dataDir,
      webDist: OPTIONS.webDist,
      authSecret: OPTIONS.authSecret,
      clientVersion: OPTIONS.clientVersion,
    });
    const launch = nodeChildLaunch(
      "/Applications/Ember.app/Ember",
      "/e.js",
      env,
    );

    expect(launch.command).toBe("/Applications/Ember.app/Ember");
    expect(launch.args).toEqual(["/e.js"]);
    expect(launch.options.env).toEqual({ ...env, ELECTRON_RUN_AS_NODE: "1" });
    // A patch over process.env would be the bug server-env.ts is written
    // against; and the child gets no stdin, both pipes, and no console window.
    expect(launch.options.env).not.toHaveProperty("PATH");
    expect(launch.options.stdio).toEqual(["ignore", "pipe", "pipe"]);
    expect(launch.options.windowsHide).toBe(true);
  });
});

describe("the orphan backstop", () => {
  /** `process`, as far as `stopChildOnExit` is concerned. */
  function host() {
    const listeners = new Set<() => void>();
    return {
      once: (_event: "exit", listener: () => void) => listeners.add(listener),
      removeListener: (_event: "exit", listener: () => void) =>
        listeners.delete(listener),
      exit: () => {
        for (const listener of [...listeners]) {
          listener();
        }
      },
      get size() {
        return listeners.size;
      },
    };
  }

  function child(exitCode: number | null = null) {
    let onExit: (() => void) | undefined;
    return {
      exitCode,
      signalCode: null,
      kills: 0,
      kill() {
        this.kills += 1;
        return true;
      },
      once(_event: "exit", listener: () => void) {
        onExit = listener;
        return this;
      },
      exit() {
        onExit?.();
      },
    };
  }

  it("kills a bouncer the shell is about to leave behind", () => {
    const shell = host();
    const bouncer = child();
    stopChildOnExit(bouncer, shell);
    shell.exit();
    expect(bouncer.kills).toBe(1);
  });

  it("signals nothing once the child has exited on its own", () => {
    const shell = host();
    const bouncer = child(0);
    stopChildOnExit(bouncer, shell);
    shell.exit();
    expect(bouncer.kills).toBe(0);
  });

  it("lets go of the listener when the child goes first", () => {
    const shell = host();
    const bouncer = child();
    stopChildOnExit(bouncer, shell);
    expect(shell.size).toBe(1);
    bouncer.exit();
    // A shell that starts a bouncer per mode switch would otherwise pile up
    // one `exit` listener per boot for the whole run.
    expect(shell.size).toBe(0);
  });
});
