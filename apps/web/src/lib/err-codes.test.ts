import { describe, expect, it } from "vitest";
import { errNotice } from "./err-codes.js";

describe("errNotice", () => {
  it("uses friendly copy for known codes, keeps the number", () => {
    expect(errNotice(56, "You may only post a role play ad…")).toBe(
      "Roleplay ads are paced by F-Chat: one per channel every ten minutes. (56)",
    );
  });

  it("keeps 59 (chat-only) and 60 (ads-only) straight — wiki semantics", () => {
    // 59 fires when an AD is refused → the channel allows only chat.
    expect(errNotice(59, "")).toContain("chat-only");
    // 60 fires when CHAT is refused → the channel allows only ads.
    expect(errNotice(60, "")).toContain("ads-only");
  });

  it("falls back to the server's message for unknown codes", () => {
    expect(errNotice(999, "Mystery refusal.")).toBe("Mystery refusal. (999)");
  });
});
