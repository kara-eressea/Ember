import { describe, expect, it } from "vitest";
import { errNotice } from "./err-codes.js";

describe("errNotice", () => {
  it("uses friendly copy for known codes, keeps the number", () => {
    expect(errNotice(56, "You may only post a role play ad…")).toBe(
      "Roleplay ads are paced by F-Chat: one per channel every ten minutes. (56)",
    );
  });

  it("falls back to the server's message for unknown codes", () => {
    expect(errNotice(999, "Mystery refusal.")).toBe("Mystery refusal. (999)");
  });
});
