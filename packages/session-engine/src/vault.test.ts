import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { CredentialVault } from "./vault.js";

describe("CredentialVault", () => {
  it("stores, reads, and deletes passwords", () => {
    const vault = new CredentialVault();
    vault.set("acc-1", "hunter2");
    expect(vault.has("acc-1")).toBe(true);
    expect(vault.get("acc-1")).toBe("hunter2");
    vault.delete("acc-1");
    expect(vault.has("acc-1")).toBe(false);
    expect(vault.get("acc-1")).toBeUndefined();
  });

  it("clears everything at once", () => {
    const vault = new CredentialVault();
    vault.set("acc-1", "a");
    vault.set("acc-2", "b");
    expect(vault.size).toBe(2);
    vault.clear();
    expect(vault.size).toBe(0);
  });

  it("never leaks passwords through serialization or inspection", () => {
    const vault = new CredentialVault();
    vault.set("acc-1", "super-secret-password");
    expect(JSON.stringify(vault)).toBe("{}");
    expect(JSON.stringify({ vault })).not.toContain("super-secret-password");
    expect(inspect(vault)).not.toContain("super-secret-password");
    expect(inspect(vault, { showHidden: true, depth: null })).not.toContain(
      "super-secret-password",
    );
    // eslint-disable-next-line @typescript-eslint/no-base-to-string -- stringification leakage is exactly what this asserts against
    expect(String(vault)).not.toContain("super-secret-password");
  });
});
