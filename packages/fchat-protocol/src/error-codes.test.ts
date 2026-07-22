import { describe, expect, it } from "vitest";
import {
  FCHAT_ERROR_MESSAGES,
  FchatErrorCode,
  isChannelGoneError,
} from "./error-codes.js";

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

  it("classifies the channel-gone / not-in-channel family", () => {
    // These mean a leave is already effectively done (#327).
    expect(isChannelGoneError(FchatErrorCode.ChannelNotFound)).toBe(true); // 26
    expect(isChannelGoneError(FchatErrorCode.NotInChannel)).toBe(true); // 45
    expect(isChannelGoneError(FchatErrorCode.CharacterNotInChannel)).toBe(true); // 49
  });

  it("does not classify unrelated errors as channel-gone", () => {
    expect(isChannelGoneError(FchatErrorCode.AlreadyInChannel)).toBe(false); // 28
    expect(isChannelGoneError(FchatErrorCode.BannedFromChannel)).toBe(false); // 48
    expect(isChannelGoneError(FchatErrorCode.InviteRequired)).toBe(false); // 44
    expect(isChannelGoneError(FchatErrorCode.MessageFlood)).toBe(false); // 5
    expect(isChannelGoneError(0)).toBe(false);
  });

  it("covers the negative internal error codes", () => {
    expect(FchatErrorCode.FatalInternalError).toBe(-1);
    expect(FCHAT_ERROR_MESSAGES[-10]).toBe(
      "You may not roll dice or spin the bottle in Frontpage.",
    );
  });
});
