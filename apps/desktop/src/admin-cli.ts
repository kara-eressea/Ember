/**
 * Running the server runtime's admin CLI as a one-shot child, which is how the
 * app account is born (mx3-desktop-shell.md §3 step 2: through the admin CLI
 * code path, not by reaching into the database from here).
 *
 * **Why `child_process.spawn` and not `utilityProcess.fork`.** The spec asked
 * for a utility process, and #299 uses one for the server. But a utility
 * process has no writable stdin — Electron's own words: "Configuring `stdin`
 * to any property other than `ignore` is not supported and will result in an
 * error", and `UtilityProcess` exposes only `stdout`/`stderr`. `--password` on
 * argv is the alternative, and argv is readable by every process on the host
 * (the CLI's header says exactly that). So: spawn Electron's own binary with
 * `ELECTRON_RUN_AS_NODE=1`, which is the same runtime a utility process gets —
 * same V8, same `NODE_MODULE_VERSION`, so the Electron-ABI `argon2` in
 * `server-runtime/` loads — but as an ordinary Node child, with a stdin.
 *
 * Sequential with the server child, never concurrent: this opens the pglite
 * data directory, and pglite is single-connection with no lock of its own
 * (MX2). Provisioning finishes before `startEmbeddedServer` is called.
 */

import { spawn } from "node:child_process";
import {
  createUserArgs,
  resetPasswordArgs,
  type AppAccount,
} from "./app-account.js";

/** How long the CLI gets before it is assumed hung (argon2 hashing is ~1 s). */
const CLI_TIMEOUT_MS = 60_000;

export interface AdminCliInvocation {
  readonly command: string;
  readonly args: string[];
  readonly env: Record<string, string>;
}

export interface AdminCliResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export class AdminCliError extends Error {
  readonly stderr: string;

  constructor(message: string, stderr: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AdminCliError";
    this.stderr = stderr;
  }
}

/**
 * How the child is launched: Electron's binary in Node mode, the CLI's entry
 * as the script, and the same complete environment the server child gets. The
 * password is never in `args` — it goes down stdin.
 */
export function adminCliInvocation(options: {
  execPath: string;
  cliEntry: string;
  args: string[];
  env: Record<string, string>;
}): AdminCliInvocation {
  return {
    command: options.execPath,
    args: [options.cliEntry, ...options.args],
    env: {
      ...options.env,
      // Turns the Electron binary into a plain Node runtime (see the module
      // comment). Without this it would try to start an app.
      ELECTRON_RUN_AS_NODE: "1",
    },
  };
}

/**
 * The CLI's refusal when the row already exists — its exact words, from
 * apps/server/src/cli/admin.ts (`fail("Email or username is already taken")`).
 * Matched, not parsed: the CLI has no exit-code vocabulary, and this is the
 * one failure that has a sane recovery (see `provisionAppAccount`).
 */
export function isAccountTakenFailure(stderr: string): boolean {
  return stderr.includes("Email or username is already taken");
}

/** Runs the CLI, feeding `password` to its stdin, and asserts a clean exit. */
export async function runAdminCli(
  invocation: AdminCliInvocation,
  password: string,
): Promise<AdminCliResult> {
  return new Promise<AdminCliResult>((resolve, reject) => {
    const child = spawn(invocation.command, invocation.args, {
      env: invocation.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.stderr.on("data", (chunk: string) => (stderr += chunk));

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, CLI_TIMEOUT_MS);

    child.once("error", (cause) => {
      clearTimeout(timer);
      reject(
        new AdminCliError(
          [
            "The app couldn't finish setting up your account on this computer.",
            "",
            "Details: the account tool would not start.",
          ].join("\n"),
          stderr,
          { cause },
        ),
      );
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });

    // The whole reason for stdin: the password never touches argv or disk.
    child.stdin.on("error", () => {
      // The child may have exited before the write landed; `close` reports it.
    });
    child.stdin.end(password);
  });
}

/**
 * Puts the app account in the database with the given password, and says which
 * way it got there.
 *
 * `reset` is the recovery path for a half-finished first run: the CLI created
 * the row and then something (a failed keychain write, a crash) stopped the
 * secrets file from being written. The generated password is gone with it, so
 * the next boot cannot log in — but it can re-point the account at the new
 * one. Nothing is destroyed by that: this password is machine-generated, never
 * shown, and guards a login row on the user's own machine. (A *corrupt*
 * secrets file is a different case and stays a hard error — see `main.ts`.)
 */
export async function provisionAppAccount(options: {
  execPath: string;
  cliEntry: string;
  env: Record<string, string>;
  account: AppAccount;
  password: string;
}): Promise<"created" | "reset"> {
  const run = async (args: string[]) =>
    runAdminCli(
      adminCliInvocation({
        execPath: options.execPath,
        cliEntry: options.cliEntry,
        args,
        env: options.env,
      }),
      options.password,
    );

  const created = await run(createUserArgs(options.account));
  if (created.code === 0) {
    return "created";
  }
  if (!isAccountTakenFailure(created.stderr)) {
    throw new AdminCliError(
      [
        "The app couldn't finish setting up your account on this computer.",
        "",
        `Details: creating the local account failed (exit code ${String(created.code)}).`,
      ].join("\n"),
      `${created.stderr}${created.stdout}`.trim(),
    );
  }
  const reset = await run(resetPasswordArgs(options.account));
  if (reset.code !== 0) {
    throw new AdminCliError(
      [
        "The app couldn't finish setting up your account on this computer.",
        "",
        `Details: the local account already exists and resetting its password failed (exit code ${String(reset.code)}).`,
      ].join("\n"),
      `${reset.stderr}${reset.stdout}`.trim(),
    );
  }
  return "reset";
}
