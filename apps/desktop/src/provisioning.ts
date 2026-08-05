/**
 * The one decision first-run provisioning turns on: is there a secrets file?
 *
 * Kept pure (and Electron-free) so the branch is testable without booting an
 * app — the expensive half, creating the account and writing the file, is
 * `main.ts`'s job to carry out.
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
      "This computer's secure storage (the OS keychain) is unavailable, so there is nowhere safe to keep the app's secrets. EmberChat will not fall back to storing them unencrypted.",
    );
  }
  return {
    kind: "provision",
    secrets: (options.generate ?? generateSecrets)(),
  };
}
