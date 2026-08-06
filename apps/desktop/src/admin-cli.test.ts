/**
 * First-run provisioning's decision table, walked against a real child process
 * that is not the admin CLI.
 *
 * The child is a fixture script run by this process's own Node (`spawn` is
 * what `runAdminCli` uses, and the point is to test *it* — a mocked spawn
 * would test the mock). The script reads stdin, records what it was given, and
 * exits with whatever the case asked for, so every branch of
 * `provisionAppAccount` is reachable in milliseconds: created, already-taken →
 * reset, reset failed, the tool that would not start, and the hang.
 *
 * This is the one path a new machine has no way around — if it breaks, the
 * first launch is bricked and there is nothing the user can do about it.
 */

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  adminCliInvocation,
  AdminCliError,
  provisionAppAccount,
  runAdminCli,
} from "./admin-cli.js";
import { appAccount, createUserArgs } from "./app-account.js";
import { buildAdminCliEnv } from "./server-env.js";

/**
 * Stands in for `server-runtime/dist/cli/admin.js`. Two environment variables
 * drive it: `FAKE_CLI_SCRIPT` says what to do per subcommand, `FAKE_CLI_LOG`
 * is where it records the call. It ends by letting the event loop drain rather
 * than calling `process.exit`, so nothing it wrote to a pipe is lost on the
 * way out.
 */
const FIXTURE = `"use strict";
const { appendFileSync } = require("node:fs");
let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { stdin += chunk; });
process.stdin.on("end", () => {
  const args = process.argv.slice(2);
  const script = JSON.parse(process.env.FAKE_CLI_SCRIPT || "{}");
  const step = script[args[0]] || {};
  appendFileSync(
    process.env.FAKE_CLI_LOG,
    JSON.stringify({ args, stdin, env: Object.keys(process.env).sort() }) + "\\n",
  );
  if (step.stderr) { process.stderr.write(step.stderr); }
  if (step.stdout) { process.stdout.write(step.stdout); }
  if (step.hang) { setInterval(() => {}, 1000); return; }
  process.exitCode = step.code || 0;
});
`;

/** The CLI's exact refusal when the row is already there (admin.ts). */
const TAKEN = "Email or username is already taken\n";

const ACCOUNT = appAccount("EmberChat");
const DATA_DIR = "/user-data/db";

let workspace: string;
let cliEntry: string;
let logPath: string;

interface Call {
  args: string[];
  stdin: string;
  env: string[];
}

/** What each subcommand should do, in the fixture's own vocabulary. */
type Script = Record<
  string,
  { code?: number; stderr?: string; stdout?: string; hang?: boolean }
>;

function env(script: Script): Record<string, string> {
  return {
    ...buildAdminCliEnv({ dataDir: DATA_DIR, authSecret: "an-auth-secret" }),
    FAKE_CLI_SCRIPT: JSON.stringify(script),
    FAKE_CLI_LOG: logPath,
  };
}

function calls(): Call[] {
  return readFileSync(logPath, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Call);
}

function provision(script: Script): Promise<"created" | "reset"> {
  return provisionAppAccount({
    execPath: process.execPath,
    cliEntry,
    env: env(script),
    account: ACCOUNT,
    password: "a-generated-password",
  });
}

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "ember-admin-cli-"));
  cliEntry = join(workspace, "fake-admin-cli.cjs");
  logPath = join(workspace, "calls.log");
  writeFileSync(cliEntry, FIXTURE);
  writeFileSync(logPath, "");
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("runAdminCli", () => {
  it("feeds the password down stdin and reports the clean exit", async () => {
    const result = await runAdminCli(
      adminCliInvocation({
        execPath: process.execPath,
        cliEntry,
        args: createUserArgs(ACCOUNT),
        env: env({ "create-user": { stdout: "Created user ember-app\n" } }),
      }),
      "a-generated-password",
    );

    expect(result).toEqual({
      code: 0,
      stdout: "Created user ember-app\n",
      stderr: "",
    });
    const [call] = calls();
    expect(call?.stdin).toBe("a-generated-password");
    // argv is world-readable on every OS this ships to; the password is the
    // one thing that must never be in it.
    expect(call?.args.join(" ")).not.toContain("a-generated-password");
  });

  it("gives the child exactly the environment it was handed", async () => {
    // A developer's shell pointing somewhere else entirely must not reach a
    // tool whose whole job is to write to the local database (server-env.ts).
    vi.stubEnv("DATABASE_URL", "postgres://somewhere/else");
    await runAdminCli(
      adminCliInvocation({
        execPath: process.execPath,
        cliEntry,
        args: createUserArgs(ACCOUNT),
        env: env({}),
      }),
      "a-generated-password",
    );

    const [call] = calls();
    expect(call?.env).not.toContain("DATABASE_URL");
    expect(call?.env).toContain("PGLITE_DATA_DIR");
    // The one thing added on the way: Electron's binary has to be told to be
    // Node (it is `process.execPath` in production, not a node binary).
    expect(call?.env).toContain("ELECTRON_RUN_AS_NODE");
  });

  it("reports a non-zero exit rather than throwing", async () => {
    const result = await runAdminCli(
      adminCliInvocation({
        execPath: process.execPath,
        cliEntry,
        args: createUserArgs(ACCOUNT),
        env: env({ "create-user": { code: 1, stderr: TAKEN } }),
      }),
      "a-generated-password",
    );
    // The refusal is data here; `provisionAppAccount` is what decides it means
    // "adopt the existing row" rather than "fail".
    expect(result.code).toBe(1);
    expect(result.stderr).toBe(TAKEN);
  });

  it("kills a tool that never finishes, and says so with an exit code", async () => {
    vi.useFakeTimers();
    const running = runAdminCli(
      adminCliInvocation({
        execPath: process.execPath,
        cliEntry,
        args: createUserArgs(ACCOUNT),
        env: env({ "create-user": { hang: true } }),
      }),
      "a-generated-password",
    );
    // A first run that hangs here shows an empty window forever, so the
    // timeout is the only thing that turns it into a message.
    await vi.advanceTimersByTimeAsync(60_000);
    const result = await running;
    // SIGKILL means no exit code at all; `-1` is this module's stand-in, and
    // it is what makes the caller's `code === 0` test fail.
    expect(result.code).toBe(-1);
  });
});

describe("provisionAppAccount", () => {
  it("creates the account on a clean first run", async () => {
    await expect(provision({ "create-user": { code: 0 } })).resolves.toBe(
      "created",
    );
    // One call, and no reset: nothing existed to adopt.
    expect(calls().map((call) => call.args[0])).toEqual(["create-user"]);
  });

  it("adopts an existing account by resetting its password", async () => {
    // The half-finished first run: the row was created and the secrets file
    // never was, so the generated password is gone with it.
    await expect(
      provision({
        "create-user": { code: 1, stderr: TAKEN },
        "reset-password": { code: 0 },
      }),
    ).resolves.toBe("reset");

    const seen = calls();
    expect(seen.map((call) => call.args[0])).toEqual([
      "create-user",
      "reset-password",
    ]);
    // Both halves get the same new password — the point of the recovery is
    // that the account and the secrets file agree again.
    expect(seen[1]?.stdin).toBe("a-generated-password");
  });

  it("refuses any other failure, and does not reset over it", async () => {
    const failure = await provision({
      "create-user": { code: 3, stderr: "DATABASE_URL is not set\n" },
    }).catch((error: unknown) => error as AdminCliError);

    expect(failure).toBeInstanceOf(AdminCliError);
    expect(failure.message).toContain(
      "The app couldn't finish setting up your account on this computer.",
    );
    expect(failure.message).toContain("exit code 3");
    // The CLI's own words travel with it, for the dialog's details block.
    expect(failure.stderr).toContain("DATABASE_URL is not set");
    // Resetting a password on an account whose creation failed for an unknown
    // reason is a guess, and this one would be made against a real database.
    expect(calls().map((call) => call.args[0])).toEqual(["create-user"]);
  });

  it("reports a reset that fails as its own failure", async () => {
    const failure = await provision({
      "create-user": { code: 1, stderr: TAKEN },
      "reset-password": { code: 4, stderr: "no such user\n" },
    }).catch((error: unknown) => error as AdminCliError);

    expect(failure).toBeInstanceOf(AdminCliError);
    expect(failure.message).toContain(
      "the local account already exists and resetting its password failed (exit code 4)",
    );
    expect(failure.stderr).toContain("no such user");
  });

  it("reports a tool that will not start at all", async () => {
    const failure = await provisionAppAccount({
      execPath: join(workspace, "there-is-no-such-binary"),
      cliEntry,
      env: env({}),
      account: ACCOUNT,
      password: "a-generated-password",
    }).catch((error: unknown) => error as AdminCliError);

    // The packaged-layout failure: `resources/server-runtime` missing or
    // unexecutable. It must not look like a database error.
    expect(failure).toBeInstanceOf(AdminCliError);
    expect(failure.message).toContain("the account tool would not start");
    expect(calls()).toEqual([]);
  });
});
