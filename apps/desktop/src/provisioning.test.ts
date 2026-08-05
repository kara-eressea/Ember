import { describe, expect, it } from "vitest";
import { planBoot, secretsPath } from "./provisioning.js";
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
    expect(secretsPath("/data/EmberChat")).toBe("/data/EmberChat/secrets.json");
  });
});
