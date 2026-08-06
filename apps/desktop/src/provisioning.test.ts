import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { planBoot, provisionFirstRun, secretsPath } from "./provisioning.js";
import { EncryptionUnavailableError, type DesktopSecrets } from "./secrets.js";

const STORED: DesktopSecrets = {
  authSecret: "stored-auth-secret",
  appAccountPassword: "stored-password",
};
const FRESH: DesktopSecrets = {
  authSecret: "fresh-auth-secret",
  appAccountPassword: "fresh-password",
};

describe("planBoot", () => {
  it("provisions when there is no secrets file", () => {
    expect(
      planBoot({
        stored: undefined,
        encryptionAvailable: true,
        generate: () => FRESH,
      }),
    ).toEqual({ kind: "provision", secrets: FRESH });
  });

  it("reuses the stored secrets on every later boot", () => {
    let generated = false;
    const plan = planBoot({
      stored: STORED,
      encryptionAvailable: true,
      generate: () => {
        generated = true;
        return FRESH;
      },
    });
    expect(plan).toEqual({ kind: "reuse", secrets: STORED });
    // The AUTH_SECRET must be the same one every boot, or every restart would
    // invalidate the seeded session.
    expect(generated).toBe(false);
  });

  it("fails closed when the OS keychain is unavailable on a first run", () => {
    expect(() =>
      planBoot({ stored: undefined, encryptionAvailable: false }),
    ).toThrow(EncryptionUnavailableError);
  });

  it("does not care about keychain availability once secrets are in hand", () => {
    // Unreachable in practice (decrypting them needed it), but the branch must
    // not be the thing that decides it.
    expect(planBoot({ stored: STORED, encryptionAvailable: false }).kind).toBe(
      "reuse",
    );
  });

  it("keeps the secrets file in the user data directory", () => {
    // `join` rather than a literal: this suite runs on Windows too (MX4's
    // packaging legs), where the separator is the other one.
    expect(secretsPath(join("/data", "EmberChat"))).toBe(
      join("/data", "EmberChat", "secrets.json"),
    );
  });
});

describe("provisionFirstRun", () => {
  /** Records the steps in the order they happen, with their boundaries. */
  function recorder(overrides: { stops?: boolean } = {}) {
    const log: string[] = [];
    const steps = {
      appName: "EmberChat",
      startMigrator: async () => {
        log.push("migrator:start");
        await Promise.resolve();
        return {
          stop: async () => {
            await Promise.resolve();
            log.push("migrator:stopped");
            return overrides.stops ?? true;
          },
        };
      },
      createAccount: async () => {
        log.push("cli:start");
        await Promise.resolve();
        log.push("cli:done");
      },
      persistSecrets: () => {
        log.push("secrets:written");
      },
    };
    return { log, steps };
  }

  it("never lets the admin CLI overlap the server that migrates", async () => {
    const { log, steps } = recorder();
    await provisionFirstRun(steps);
    // The invariant pglite makes load-bearing: the CLI child opens the same
    // data directory, so it may only start once the server holding it is
    // gone (apps/server/src/test-support/db.ts).
    expect(log).toEqual([
      "migrator:start",
      "migrator:stopped",
      "cli:start",
      "cli:done",
      "secrets:written",
    ]);
  });

  it("refuses to run the CLI when the migrate-only server would not stop", async () => {
    const { log, steps } = recorder({ stops: false });
    await expect(provisionFirstRun(steps)).rejects.toThrow("did not shut down");
    // Nothing after the failed stop ran: a second process on that directory
    // is the failure mode, so refusing is the only safe answer.
    expect(log).toEqual(["migrator:start", "migrator:stopped"]);
  });

  it("writes the secrets file only after the account exists", async () => {
    const { log, steps } = recorder();
    await expect(
      provisionFirstRun({
        ...steps,
        createAccount: () => {
          log.push("cli:start");
          return Promise.reject(new Error("create-user failed"));
        },
      }),
    ).rejects.toThrow("create-user failed");
    // A secrets file written here would make the next boot skip provisioning
    // entirely, leaving a database with no account anyone has the password to.
    expect(log).not.toContain("secrets:written");
  });
});
