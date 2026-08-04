// Which ERRs mean "your private message was not delivered" (#491).

import { describe, expect, it } from "vitest";

import { FchatErrorCode, isPrivateMessageRefusal } from "./error-codes.js";

describe("isPrivateMessageRefusal", () => {
  it("covers the two refusals a PRI can draw", () => {
    expect(isPrivateMessageRefusal(FchatErrorCode.CharacterNotFound)).toBe(
      true,
    );
    expect(isPrivateMessageRefusal(FchatErrorCode.IgnoredByRecipient)).toBe(
      true,
    );
  });

  it("excludes errors other commands can raise for their own reasons", () => {
    for (const code of [
      // A channel MSG can raise this in the same breath as a DM.
      FchatErrorCode.MessageTooLong,
      FchatErrorCode.MessageFlood,
      FchatErrorCode.CharacterNotInChannel,
      FchatErrorCode.NotInChannel,
      FchatErrorCode.SearchFlood,
      FchatErrorCode.UnknownError,
    ]) {
      expect(isPrivateMessageRefusal(code)).toBe(false);
    }
  });
});
