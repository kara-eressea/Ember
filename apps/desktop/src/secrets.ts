/**
 * The two long-lived secrets a local-mode install owns — the bouncer's
 * `AUTH_SECRET` and the app account's password — and the only place they are
 * allowed to live: `<userData>/secrets.json`, every value encrypted with
 * Electron's `safeStorage` (the OS keychain / DPAPI / libsecret).
 *
 * Spec invariant 4: **no plaintext fallback, ever**. If the platform says
 * encryption is unavailable, provisioning fails closed with an explanation
 * rather than writing a file anybody can read.
 *
 * Nothing here imports Electron — `safeStorage` is passed in as an
 * `Encryptor`, whose shape is exactly the slice of `safeStorage` this module
 * uses, so `main.ts` hands over the real thing and the tests hand over a fake.
 */

import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

/** Bumped if the file's shape changes; an unknown version is a hard error. */
export const SECRETS_SCHEMA_VERSION = 1;

/** The `safeStorage` surface this module needs — see the module comment. */
export interface Encryptor {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

export interface DesktopSecrets {
  /** JWT signing secret for the embedded server. Stable across boots — that
   * stability is what lets a seeded session survive a restart. */
  readonly authSecret: string;
  /** The app account's password. Generated once, never shown, never typed. */
  readonly appAccountPassword: string;
}

interface SecretsFile {
  version: number;
  authSecret: string;
  appAccountPassword: string;
}

/** The OS keychain is not available: provisioning must stop, not degrade. */
export class EncryptionUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EncryptionUnavailableError";
  }
}

/** The file exists but cannot be read back — wrong shape, wrong key, truncated. */
export class SecretsCorruptError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SecretsCorruptError";
  }
}

/** 32 bytes of randomness each: the JWT secret and the account password. */
export function generateSecrets(): DesktopSecrets {
  return {
    authSecret: randomBytes(32).toString("base64url"),
    appAccountPassword: randomBytes(32).toString("base64url"),
  };
}

export function encodeSecrets(
  secrets: DesktopSecrets,
  encryptor: Encryptor,
): string {
  if (!encryptor.isEncryptionAvailable()) {
    throw new EncryptionUnavailableError(
      "This computer's secure storage (its keychain) isn't available.",
    );
  }
  const file: SecretsFile = {
    version: SECRETS_SCHEMA_VERSION,
    authSecret: encryptor.encryptString(secrets.authSecret).toString("base64"),
    appAccountPassword: encryptor
      .encryptString(secrets.appAccountPassword)
      .toString("base64"),
  };
  return `${JSON.stringify(file, undefined, 2)}\n`;
}

export function decodeSecrets(
  contents: string,
  encryptor: Encryptor,
): DesktopSecrets {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch (cause) {
    throw new SecretsCorruptError("the file is not valid JSON", { cause });
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new SecretsCorruptError("the file is not an object");
  }
  const file = parsed as Partial<SecretsFile>;
  if (file.version !== SECRETS_SCHEMA_VERSION) {
    throw new SecretsCorruptError(
      `unsupported format version ${String(file.version)} (expected ${String(SECRETS_SCHEMA_VERSION)})`,
    );
  }
  if (
    typeof file.authSecret !== "string" ||
    typeof file.appAccountPassword !== "string"
  ) {
    throw new SecretsCorruptError("a stored value is missing");
  }
  if (!encryptor.isEncryptionAvailable()) {
    throw new EncryptionUnavailableError(
      "This computer's secure storage (its keychain) isn't available.",
    );
  }
  try {
    return {
      authSecret: encryptor.decryptString(
        Buffer.from(file.authSecret, "base64"),
      ),
      appAccountPassword: encryptor.decryptString(
        Buffer.from(file.appAccountPassword, "base64"),
      ),
    };
  } catch (cause) {
    throw new SecretsCorruptError("a stored value could not be decrypted", {
      cause,
    });
  }
}

/**
 * The stored secrets, or `undefined` when there is no file yet — which is the
 * one and only signal for "this is a first run" (see `provisioning.ts`).
 * A file that exists but will not decode throws: silently regenerating would
 * strand the account already in the database.
 */
export function readSecrets(
  path: string,
  encryptor: Encryptor,
): DesktopSecrets | undefined {
  let contents: string;
  try {
    contents = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
  return decodeSecrets(contents, encryptor);
}

/** Owner-only (0600) — belt to safeStorage's braces. */
export function writeSecrets(
  path: string,
  secrets: DesktopSecrets,
  encryptor: Encryptor,
): void {
  writeFileSync(path, encodeSecrets(secrets, encryptor), { mode: 0o600 });
}
