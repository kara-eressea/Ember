import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  decodeSecrets,
  encodeSecrets,
  EncryptionUnavailableError,
  generateSecrets,
  readSecrets,
  SecretsCorruptError,
  SECRETS_SCHEMA_VERSION,
  writeSecrets,
  type Encryptor,
} from "./secrets.js";

/**
 * Stands in for Electron's `safeStorage`. Not encryption — a reversible marker
 * that proves the values went through the encryptor and that a value encrypted
 * elsewhere (a different "keychain") fails to come back out.
 */
function fakeEncryptor(options?: {
  available?: boolean;
  keyId?: string;
}): Encryptor {
  const keyId = options?.keyId ?? "key-a";
  return {
    isEncryptionAvailable: () => options?.available ?? true,
    encryptString: (plainText) => Buffer.from(`${keyId}:${plainText}`, "utf8"),
    decryptString: (encrypted) => {
      const text = encrypted.toString("utf8");
      if (!text.startsWith(`${keyId}:`)) {
        throw new Error("cannot decrypt: wrong key");
      }
      return text.slice(keyId.length + 1);
    },
  };
}

const SECRETS = {
  authSecret: "auth-secret-value",
  appAccountPassword: "app-account-password",
};

describe("secrets file", () => {
  it("round-trips through the encryptor", () => {
    const encryptor = fakeEncryptor();
    expect(decodeSecrets(encodeSecrets(SECRETS, encryptor), encryptor)).toEqual(
      SECRETS,
    );
  });

  it("stores a version and base64 ciphertext, never the plaintext", () => {
    const encoded = encodeSecrets(SECRETS, fakeEncryptor());
    expect(encoded).not.toContain("app-account-password");
    expect(encoded).not.toContain("auth-secret-value");
    const parsed = JSON.parse(encoded) as Record<string, unknown>;
    expect(parsed["version"]).toBe(SECRETS_SCHEMA_VERSION);
    for (const field of ["authSecret", "appAccountPassword"] as const) {
      const value = parsed[field];
      expect(typeof value).toBe("string");
      // Base64 in, same bytes out — no other encoding sneaked in.
      expect(Buffer.from(value as string, "base64").toString("base64")).toBe(
        value,
      );
    }
  });

  it("refuses to encode without OS encryption (invariant 4: no plaintext)", () => {
    expect(() =>
      encodeSecrets(SECRETS, fakeEncryptor({ available: false })),
    ).toThrow(EncryptionUnavailableError);
  });

  it("rejects an unknown schema version", () => {
    const encryptor = fakeEncryptor();
    const file = JSON.parse(encodeSecrets(SECRETS, encryptor)) as {
      version: number;
    };
    file.version = SECRETS_SCHEMA_VERSION + 1;
    expect(() => decodeSecrets(JSON.stringify(file), encryptor)).toThrow(
      SecretsCorruptError,
    );
  });

  it.each([
    ["not JSON at all", "{not json"],
    ["not an object", '"a string"'],
    ["missing a value", `{"version":${String(SECRETS_SCHEMA_VERSION)}}`],
  ])("rejects a file that is %s", (_label, contents) => {
    expect(() => decodeSecrets(contents, fakeEncryptor())).toThrow(
      SecretsCorruptError,
    );
  });

  it("rejects ciphertext another keychain wrote", () => {
    const encoded = encodeSecrets(SECRETS, fakeEncryptor({ keyId: "key-a" }));
    expect(() =>
      decodeSecrets(encoded, fakeEncryptor({ keyId: "key-b" })),
    ).toThrow(SecretsCorruptError);
  });

  it("generates distinct, long, url-safe secrets", () => {
    const generated = generateSecrets();
    expect(generated.authSecret).not.toBe(generated.appAccountPassword);
    for (const value of Object.values(generated)) {
      expect(value).toMatch(/^[A-Za-z0-9_-]{32,}$/);
    }
  });
});

describe("secrets on disk", () => {
  it("reports a missing file as undefined — the first-run signal", () => {
    const dir = mkdtempSync(join(tmpdir(), "eb-secrets-"));
    expect(readSecrets(join(dir, "secrets.json"), fakeEncryptor())).toBe(
      undefined,
    );
  });

  it("writes owner-only and reads back what it wrote", () => {
    const dir = mkdtempSync(join(tmpdir(), "eb-secrets-"));
    const path = join(dir, "secrets.json");
    const encryptor = fakeEncryptor();
    writeSecrets(path, SECRETS, encryptor);
    expect(readSecrets(path, encryptor)).toEqual(SECRETS);
    expect(readFileSync(path, "utf8")).not.toContain("app-account-password");
  });

  it("throws rather than silently reprovisioning over a corrupt file", () => {
    const dir = mkdtempSync(join(tmpdir(), "eb-secrets-"));
    const path = join(dir, "secrets.json");
    writeFileSync(path, "{}");
    expect(() => readSecrets(path, fakeEncryptor())).toThrow(
      SecretsCorruptError,
    );
  });
});
