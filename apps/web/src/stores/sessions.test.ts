// DM row presence: a freshly opened DM must reflect the partner's live
// presence at once (#229), then keep folding live NLN/STA updates.

import { beforeEach, describe, expect, it } from "vitest";
import type { ConversationDto } from "@emberchat/protocol";
import { useSessionsStore } from "./sessions.js";

const IDENTITY = "11111111-1111-7111-8111-111111111111";
const CONV = "22222222-2222-7222-8222-222222222222";

function pmConversation(
  partner: string,
  presence?: ConversationDto["presence"],
): ConversationDto {
  return {
    id: CONV,
    kind: "pm",
    channelKey: null,
    partnerCharacter: partner,
    title: partner,
    pinned: false,
    joined: true,
    lastReadMessageId: null,
    ...(presence ? { presence } : {}),
  };
}

beforeEach(() => {
  useSessionsStore.getState().reset();
});

describe("DM row presence seeding (#229)", () => {
  it("seeds a new DM row from the pm.open presence", () => {
    useSessionsStore.getState().applyConversation(
      IDENTITY,
      pmConversation("Nyx Firemane", {
        online: true,
        status: "away",
        statusmsg: "brb",
      }),
    );
    const dm = useSessionsStore.getState().sessions[IDENTITY]?.dms[CONV];
    expect(dm).toMatchObject({
      partner: "Nyx Firemane",
      online: true,
      status: "away",
      statusmsg: "brb",
    });
  });

  it("defaults to offline when no presence rides the conversation", () => {
    useSessionsStore
      .getState()
      .applyConversation(IDENTITY, pmConversation("Nyx Firemane"));
    const dm = useSessionsStore.getState().sessions[IDENTITY]?.dms[CONV];
    expect(dm).toMatchObject({ online: false, status: "", statusmsg: "" });
  });

  it("keeps folding live presence after creation, case-insensitively", () => {
    const store = useSessionsStore.getState();
    store.applyConversation(
      IDENTITY,
      pmConversation("Nyx Firemane", {
        online: true,
        status: "online",
        statusmsg: "",
      }),
    );
    store.applyPresence(IDENTITY, {
      character: "nyx firemane",
      online: false,
    });
    const dm = useSessionsStore.getState().sessions[IDENTITY]?.dms[CONV];
    expect(dm?.online).toBe(false);
  });
});
