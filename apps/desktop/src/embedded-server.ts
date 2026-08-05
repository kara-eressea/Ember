import { spawn } from "node:child_process";
import { utilityProcess } from "electron";
import { findFreePort, loopbackOrigin } from "./loopback.js";
import { buildServerEnv } from "./server-env.js";

export interface StartEmbeddedServerOptions {
  /** `<server-runtime>/dist/main.js` — the Electron-ABI server tree. */
  readonly entry: string;
  readonly dataDir: string;
  readonly webDist: string;
  readonly authSecret: string;
  readonly clientVersion: string;
  /** How long to wait for the first `/healthz` 200 before giving up. */
  readonly readyTimeoutMs?: number;
}

export interface EmbeddedServer {
  readonly origin: string;
  readonly port: number;
  /**
   * SIGTERMs the child and resolves `true` once it is confirmed gone, or
   * `false` if it was still alive after the grace period (Electron's
   * `utilityProcess.kill()` has no stronger signal to follow up with).
   *
   * The boolean is not decoration: first-run provisioning runs the admin CLI
   * the moment this returns, and pglite has no lock — a second writer on the
   * same data directory is corruption, so that caller must refuse to continue
   * on `false`.
   */
  stop(): Promise<boolean>;
  /** Called if the child dies on its own after a successful boot. */
  onUnexpectedExit(listener: (code: number) => void): void;
}

/** How long a graceful SIGTERM gets before the child is killed outright. */
const STOP_GRACE_MS = 5_000;
const READY_TIMEOUT_MS = 60_000;
const READY_POLL_MS = 150;
/** Tail of the child's stderr kept for the crash dialog. */
const STDERR_KEEP_BYTES = 8_000;
/**
 * How many ports a boot may try before giving up (MX4, #305).
 *
 * `findFreePort` documents the race it accepts: the port is probed in this
 * process, released, and bound by the child a moment later, and anything on the
 * machine may take it in between. Windows widens that gap into something worth
 * handling — the OS keeps ranges of ephemeral ports excluded (Hyper-V, WSL and
 * anything else that reserved a block), and a bind into one of those fails for
 * that port and no other. A second draw costs milliseconds and turns a
 * coin-toss failure into a retry; three of them failing is a real problem and
 * should be reported as one, which is why this is a small number and not a
 * loop.
 */
const PORT_ATTEMPTS = 3;

/**
 * Forks the bouncer as an Electron `utilityProcess` and waits for it to answer
 * `/healthz` (the same readiness contract the container image's smoke test
 * uses). Rejects — with the child's own stderr attached — if it dies first,
 * so a broken boot shows the reason instead of a blank window.
 *
 * A child that dies before it is ready gets a fresh port and one more go (up to
 * `PORT_ATTEMPTS`); see there for why the port and not something else.
 */
export async function startEmbeddedServer(
  options: StartEmbeddedServerOptions,
): Promise<EmbeddedServer> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await startOnce(options);
    } catch (error) {
      const worthAnotherPort =
        attempt < PORT_ATTEMPTS &&
        error instanceof EmbeddedServerStartError &&
        error.childExited;
      if (!worthAnotherPort) {
        throw error;
      }
      console.warn(
        `The bouncer did not come up on that port (attempt ${String(attempt)} of ${String(PORT_ATTEMPTS)}); trying another.`,
      );
    }
  }
}

async function startOnce(
  options: StartEmbeddedServerOptions,
): Promise<EmbeddedServer> {
  const port = await findFreePort();
  const origin = loopbackOrigin(port);
  const env = buildServerEnv({
    port,
    dataDir: options.dataDir,
    webDist: options.webDist,
    authSecret: options.authSecret,
    clientVersion: options.clientVersion,
  });

  const child = forkServerChild(options.entry, env);

  let stderr = "";
  const capture = (chunk: Buffer | string, stream: NodeJS.WriteStream) => {
    const text = String(chunk);
    stderr = (stderr + text).slice(-STDERR_KEEP_BYTES);
    // Dev ergonomics: the bouncer's log belongs on the shell's console too.
    stream.write(text);
  };
  child.stdout?.on("data", (chunk: Buffer) => {
    capture(chunk, process.stdout);
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    capture(chunk, process.stderr);
  });

  let exitCode: number | undefined;
  const exited = new Promise<number>((resolve) => {
    child.once("exit", (code) => {
      // A spawned child reports `null` when a signal ended it (Node's own
      // convention) where a utility process always has a number. Everything
      // downstream only asks "has it exited", so one stands in for the other.
      exitCode = code ?? -1;
      resolve(exitCode);
    });
  });

  try {
    await waitForHealthz(origin, {
      timeoutMs: options.readyTimeoutMs ?? READY_TIMEOUT_MS,
      hasExited: () => exitCode !== undefined,
    });
  } catch (cause) {
    if (exitCode === undefined) {
      child.kill();
    }
    throw new EmbeddedServerStartError(
      exitCode === undefined
        ? `The bouncer did not become ready in time (${origin}).`
        : `The bouncer exited with code ${String(exitCode)} before it was ready.`,
      stderr.trim(),
      { cause, childExited: exitCode !== undefined },
    );
  }

  return {
    origin,
    port,
    async stop() {
      if (exitCode !== undefined) {
        return true;
      }
      // SIGTERM: main.ts's signal handler closes Fastify and the database
      // cleanly, which matters more here than anywhere — pglite is a file on
      // the user's disk, not a server someone else runs.
      child.kill();
      return Promise.race([
        exited.then(() => true),
        new Promise<false>((resolve) =>
          setTimeout(() => {
            resolve(false);
          }, STOP_GRACE_MS),
        ),
      ]);
    },
    onUnexpectedExit(listener) {
      void exited.then(listener);
    },
  };
}

/** The little of a child process this module uses, from either mechanism. */
interface ServerChild {
  readonly stdout: NodeJS.ReadableStream | null;
  readonly stderr: NodeJS.ReadableStream | null;
  once(event: "exit", listener: (code: number | null) => void): unknown;
  kill(): unknown;
}

/**
 * Start the bouncer as a child of this process — by one of two mechanisms,
 * and the split is a Windows finding from MX4 (#305).
 *
 * **macOS: `utilityProcess.fork`**, as MX3 built it. Electron's own supported
 * Node child: it dies with the main process automatically, which is worth
 * having for a child that holds a pglite data directory no second writer may
 * touch.
 *
 * **Windows: `child_process.spawn` of Electron's own binary with
 * `ELECTRON_RUN_AS_NODE=1`** — the same trick `admin-cli.ts` already uses for
 * the same reason it gives there: it is the identical runtime (same V8, same
 * `NODE_MODULE_VERSION`, so `server-runtime`'s Electron-ABI argon2 and re2
 * load) as an ordinary OS process.
 *
 * Why the split exists, measured rather than assumed. A utility process on
 * Windows cannot open a listening socket: the bouncer died on
 * `listen UNKNOWN 127.0.0.1:<port>` on three different ports in a row, with
 * `getaddrinfo EAI_FAIL` and `WSALookupServiceBegin failed with: 10108`
 * alongside it — the signature of a process that has no usable Winsock. On the
 * *same machine, in the same CI job*, two probes both succeeded: plain Node,
 * and the packaged Electron binary run as Node. None of the refused ports were
 * in the OS's excluded ranges. So it is not the host, not the port and not
 * Electron — it is the process type, and this is the process type that works.
 *
 * The cost, and it is the reason macOS is left alone: a spawned child is not
 * cleaned up by Electron if this process dies without running `will-quit`.
 * `stopChildOnExit` below closes the ordinary paths; a hard crash of the main
 * process could still leave a bouncer holding the data directory.
 */
function forkServerChild(
  entry: string,
  env: Record<string, string>,
): ServerChild {
  if (process.platform !== "win32") {
    return utilityProcess.fork(entry, [], {
      serviceName: "emberchat-server",
      env,
      stdio: "pipe",
    });
  }
  const child = spawn(process.execPath, [entry], {
    env: { ...env, ELECTRON_RUN_AS_NODE: "1" },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  stopChildOnExit(child);
  return child;
}

/**
 * The backstop `utilityProcess` gives for free and a spawned child does not:
 * do not outlive the shell. `will-quit` is still the only *deliberate* stop
 * (invariant 6) — this is for the paths that never reach it, and it is
 * deliberately a kill rather than a graceful close, because by the time
 * `process.on("exit")` runs nothing asynchronous can still happen.
 */
function stopChildOnExit(child: ReturnType<typeof spawn>): void {
  const kill = () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
    }
  };
  process.once("exit", kill);
  child.once("exit", () => {
    process.removeListener("exit", kill);
  });
}

/** A boot failure carrying whatever the child managed to say on the way down. */
export class EmbeddedServerStartError extends Error {
  readonly childStderr: string;
  /**
   * Whether the child died on its own, as opposed to never becoming ready while
   * still alive. Only the first is worth another port — a child that is up and
   * silent has a different problem, and retrying it would cost three times the
   * ready timeout to arrive at the same answer.
   */
  readonly childExited: boolean;

  constructor(
    message: string,
    childStderr: string,
    options?: ErrorOptions & { childExited?: boolean },
  ) {
    super(message, options);
    this.name = "EmbeddedServerStartError";
    this.childStderr = childStderr;
    this.childExited = options?.childExited ?? false;
  }
}

async function waitForHealthz(
  origin: string,
  options: { timeoutMs: number; hasExited: () => boolean },
): Promise<void> {
  const deadline = Date.now() + options.timeoutMs;
  for (;;) {
    if (options.hasExited()) {
      throw new Error("the server process exited before answering /healthz");
    }
    try {
      const response = await fetch(`${origin}/healthz`);
      if (response.ok) {
        return;
      }
    } catch {
      // Connection refused while the child is still starting — expected.
    }
    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting for ${origin}/healthz`);
    }
    await new Promise((resolve) => setTimeout(resolve, READY_POLL_MS));
  }
}
