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
  /** Resolves once the child is gone (SIGTERM first, SIGKILL as a backstop). */
  stop(): Promise<void>;
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
 * Forks the bouncer as an Electron `utilityProcess` and waits for it to answer
 * `/healthz` (the same readiness contract the container image's smoke test
 * uses). Rejects — with the child's own stderr attached — if it dies first,
 * so a broken boot shows the reason instead of a blank window.
 */
export async function startEmbeddedServer(
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

  const child = utilityProcess.fork(options.entry, [], {
    serviceName: "emberchat-server",
    env,
    stdio: "pipe",
  });

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
    child.once("exit", (code: number) => {
      exitCode = code;
      resolve(code);
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
      { cause },
    );
  }

  return {
    origin,
    port,
    async stop() {
      if (exitCode !== undefined) {
        return;
      }
      // SIGTERM: main.ts's signal handler closes Fastify and the database
      // cleanly, which matters more here than anywhere — pglite is a file on
      // the user's disk, not a server someone else runs.
      child.kill();
      await Promise.race([
        exited,
        new Promise((resolve) => setTimeout(resolve, STOP_GRACE_MS)),
      ]);
    },
    onUnexpectedExit(listener) {
      void exited.then(listener);
    },
  };
}

/** A boot failure carrying whatever the child managed to say on the way down. */
export class EmbeddedServerStartError extends Error {
  readonly childStderr: string;

  constructor(message: string, childStderr: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "EmbeddedServerStartError";
    this.childStderr = childStderr;
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
