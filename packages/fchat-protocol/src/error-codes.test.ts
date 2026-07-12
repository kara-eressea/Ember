import { describe, expect, it } from "vitest";
import { FCHAT_ERROR_MESSAGES, FchatErrorCode } from "./error-codes.js";

describe("error codes", () => {
  it("matches the documented ERR sample", () => {
    // ERR {"message": "You have already joined this channel.", "number": 28}
    expect(FchatErrorCode.AlreadyInChannel).toBe(28);
    expect(FCHAT_ERROR_MESSAGES[FchatErrorCode.AlreadyInChannel]).toBe(
      "You are already in the requested channel.",
    );
  });

  it("has a documented message for every named code", () => {
    for (const [name, code] of Object.entries(FchatErrorCode)) {
      expect(
        FCHAT_ERROR_MESSAGES[code],
        `${name} (${String(code)})`,
      ).toBeTypeOf("string");
    }
  });

  it("covers the negative internal error codes", () => {
    expect(FchatErrorCode.FatalInternalError).toBe(-1);
    expect(FCHAT_ERROR_MESSAGES[-10]).toBe(
      "You may not roll dice or spin the bottle in Frontpage.",
    );
  });
});
