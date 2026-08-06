/**
 * First-run provisioning: the one decision it turns on (is there a secrets
 * file?) and the sequence it then runs.
 *
 * Kept Electron-free so both are testable without booting an app — `main.ts`
 * supplies the steps, this file owns the order they happen in.
 */

import { join } from "node:path";
import {
  EncryptionUnavailableError,
  generateSecrets,
  type DesktopSecrets,
} from "./secrets.js";

/** `<userData>/secrets.json`. */
export function secretsPath(userDataDir: string): string {
  return join(userDataDir, "secrets.json");
}

export type BootPlan =
  /** No secrets file: generate, create the account, then write the file. */
  | { readonly kind: "provision"; readonly secrets: DesktopSecrets }
  /** Secrets decrypted: boot straight into the server and log in. */
  | { readonly kind: "reuse"; readonly secrets: DesktopSecrets };

/**
 * `stored` is whatever `readSecrets` returned — `undefined` only when the file
 * does not exist. (A file that exists and will not decode throws there and
 * never reaches this function: silently reprovisioning over it would leave the
 * database holding an account whose password nobody has.)
 *
 * Invariant 4 is enforced here for the first-run branch: without OS-backed
 * encryption there is nowhere to put the new secrets, so provisioning refuses
 * rather than writing a plaintext file. The reuse branch needed decryption to
 * get this far, so it cannot be in this position.
 */
export function planBoot(options: {
  readonly stored: DesktopSecrets | undefined;
  readonly encryptionAvailable: boolean;
  /** Injectable for tests; defaults to real randomness. */
  readonly generate?: () => DesktopSecrets;
}): BootPlan {
  if (options.stored) {
    return { kind: "reuse", secrets: options.stored };
  }
  if (!options.encryptionAvailable) {
    throw new EncryptionUnavailableError(
      "This computer's secure storage (its keychain) isn't available, so there is nowhere safe to keep the passwords the app needs. It won't store them unprotected, so it can't set itself up here.",
    );
  }
  return {
    kind: "provision",
    secrets: (options.generate ?? generateSecrets)(),
  };
}

/**
 * The first-run sequence (spec §3 step 2, MX2), whose whole point is that its
 * three steps never overlap:
 *
 *  1. one short server boot, purely to create the schema. The admin CLI does
 *     not migrate — "the server migrates on boot", as its own header says —
 *     and on a first run the database is empty, so `create-user` would fail
 *     on a table that does not exist yet.
 *  2. the CLI, and only once the server has actually exited.
 *  3. the secrets file, and only once the account exists: a file written
 *     before a failed creation would make the next boot think it had already
 *     provisioned.
 *
 * Step 2 must not start while step 1's process lives. pglite is one whole
 * Postgres inside one process, with no shared buffers and no data-directory
 * lock, so two of them over one directory are two different databases:
 * writes vanish, silently, in whichever direction the flushes fall
 * (apps/server/src/test-support/db.ts, #558). `stop()` waiting for the exit
 * is what makes this safe, which is why its `false` is fatal here.
 */
export async function provisionFirstRun(steps: {
  readonly appName: string;
  /** Boots the migrate-only server; its stop() resolves false if it hung. */
  readonly startMigrator: () => Promise<{ stop: () => Promise<boolean> }>;
  /** Runs the admin CLI as a child process against the same data directory. */
  readonly createAccount: () => Promise<unknown>;
  readonly persistSecrets: () => void;
}): Promise<void> {
  const migrator = await steps.startMigrator();
  if (!(await migrator.stop())) {
    throw new Error(
      [
        `${steps.appName} couldn't finish setting itself up on this computer, so it stopped before changing anything. Please try starting it again.`,
        "",
        "Details: the first-run setup step did not shut down.",
      ].join("\n"),
    );
  }
  await steps.createAccount();
  steps.persistSecrets();
}
