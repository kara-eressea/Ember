// DM row presence: a freshly opened DM must reflect the partner's live
// presence at once (#229), then keep folding live NLN/STA updates.
// Plus the "Seen recently" moves (#200): part adds to seen, rejoin removes —
// a nick is never in both rosters.

import { beforeEach, describe, expect, it } from "vitest";
import { PREFS_DEFAULTS } from "@emberchat/protocol";
import type { ConversationDto, MemberDto } from "@emberchat/protocol";
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

const KEY = "Frontpage";

function member(character: string, gender = "Female"): MemberDto {
  return { character, gender, status: "online", statusmsg: "" };
}

function channelState() {
  return useSessionsStore.getState().sessions[IDENTITY]?.channels[KEY];
}

describe("Seen recently roster moves (#200)", () => {
  beforeEach(() => {
    const store = useSessionsStore.getState();
    store.applyChannelMembers(IDENTITY, {
      key: KEY,
      mode: "chat",
      members: [member("Amber Vale"), member("Nyx Firemane")],
    });
  });

  it("moves a departing member into seen with their gender and a fresh stamp", () => {
    const before = Date.now();
    useSessionsStore.getState().applyMemberLeave(IDENTITY, KEY, "Nyx Firemane");
    const channel = channelState();
    expect(channel?.members.map((m) => m.character)).toEqual(["Amber Vale"]);
    expect(channel?.seen).toHaveLength(1);
    expect(channel?.seen[0]).toMatchObject({
      character: "Nyx Firemane",
      gender: "Female",
    });
    expect(channel?.seen[0]?.lastSeen).toBeGreaterThanOrEqual(before);
  });

  it("removes a rejoining member from seen — never in both rosters", () => {
    const store = useSessionsStore.getState();
    store.applyMemberLeave(IDENTITY, KEY, "Nyx Firemane");
    store.applyMemberJoin(IDENTITY, KEY, member("Nyx Firemane"));
    const channel = channelState();
    expect(channel?.seen).toEqual([]);
    expect(channel?.members.map((m) => m.character)).toContain("Nyx Firemane");
  });

  it("treats a global offline (FLN) as a part in every channel", () => {
    useSessionsStore
      .getState()
      .applyPresence(IDENTITY, { character: "Nyx Firemane", online: false });
    const channel = channelState();
    expect(channel?.members.map((m) => m.character)).toEqual(["Amber Vale"]);
    expect(channel?.seen[0]?.character).toBe("Nyx Firemane");
  });

  it("drops present members from seen on a full roster overwrite (ICH)", () => {
    const store = useSessionsStore.getState();
    store.applyMemberLeave(IDENTITY, KEY, "Nyx Firemane");
    store.applyChannelMembers(IDENTITY, {
      key: KEY,
      mode: "chat",
      members: [member("Amber Vale"), member("nyx firemane")],
    });
    expect(channelState()?.seen).toEqual([]);
  });

  it("keeps newest-first order and dedupes on repeat parts", () => {
    const store = useSessionsStore.getState();
    store.applyMemberLeave(IDENTITY, KEY, "Amber Vale");
    store.applyMemberJoin(IDENTITY, KEY, member("Nyx Firemane"));
    store.applyMemberLeave(IDENTITY, KEY, "Nyx Firemane");
    store.applyMemberJoin(IDENTITY, KEY, member("Nyx Firemane"));
    store.applyMemberLeave(IDENTITY, KEY, "Nyx Firemane");
    const seen = channelState()?.seen ?? [];
    expect(seen.map((entry) => entry.character)).toEqual([
      "Nyx Firemane",
      "Amber Vale",
    ]);
  });

  it("keeps the seen roster when our own leave clears the live list", () => {
    const store = useSessionsStore.getState();
    store.applySnapshot({
      identityId: IDENTITY,
      self: {
        character: "Amber Vale",
        sessionStatus: "online",
        status: "online",
        statusmsg: "",
        ignores: [],
        limits: {
          chatMax: 4096,
          privMax: 50000,
          lfrpMax: 50000,
          lfrpFlood: 600,
        },
        iconBlacklist: [],
        chatop: false,
        sendDelaySeconds: 0,
        prefs: PREFS_DEFAULTS,
        outbox: [],
        campaign: null,
        social: null,
      },
      channels: [
        {
          convId: CONV,
          key: KEY,
          title: KEY,
          description: "",
          mode: "chat",
          oplist: [],
          members: [member("Amber Vale"), member("Nyx Firemane")],
          seen: [{ character: "Tally Marsh", gender: "Male", lastSeen: 1 }],
          joined: true,
          pinned: false,
          unread: 0,
          mentions: 0,
          lastReadMessageId: null,
        },
      ],
      dms: [],
    });
    useSessionsStore.getState().applyMemberLeave(IDENTITY, KEY, "Amber Vale");
    const channel = channelState();
    expect(channel?.members).toEqual([]);
    expect(channel?.seen.map((entry) => entry.character)).toEqual([
      "Tally Marsh",
    ]);
  });
});

function channelConversation(lastReadMessageId: number | null): ConversationDto {
  return {
    id: CONV,
    kind: "channel",
    channelKey: KEY,
    partnerCharacter: null,
    title: KEY,
    pinned: false,
    joined: true,
    lastReadMessageId,
  };
}

describe("read-ack echo vs. live unread (#264)", () => {
  it("keeps unread when a slow ack echo lands below a newer live message", () => {
    const store = useSessionsStore.getState();
    // Register the channel + convId → key mapping.
    store.applyConversation(IDENTITY, channelConversation(null));
    // A live message id=101 bumps unread and records the newest id.
    store.bumpUnread(IDENTITY, CONV, 101, true);
    // A read-ack echo advances the cursor to 100 — below the live message,
    // so the genuinely-unread id=101 must survive.
    store.applyConversation(IDENTITY, channelConversation(100));
    const channel = channelState();
    expect(channel?.unread).toBe(1);
    expect(channel?.mentions).toBe(1);
  });

  it("zeroes once the cursor catches up to the newest live message", () => {
    const store = useSessionsStore.getState();
    store.applyConversation(IDENTITY, channelConversation(null));
    store.bumpUnread(IDENTITY, CONV, 101, true);
    // The cursor reaches the newest message (e.g. another device read all).
    store.applyConversation(IDENTITY, channelConversation(101));
    const channel = channelState();
    expect(channel?.unread).toBe(0);
    expect(channel?.mentions).toBe(0);
  });

  it("still zeroes on an advance when nothing live was tracked", () => {
    const store = useSessionsStore.getState();
    store.applyConversation(IDENTITY, channelConversation(50));
    // Seed a snapshot-style unread with no live message tracked yet.
    useSessionsStore.setState((s) => ({
      sessions: {
        ...s.sessions,
        [IDENTITY]: {
          ...s.sessions[IDENTITY]!,
          channels: {
            ...s.sessions[IDENTITY]!.channels,
            [KEY]: { ...s.sessions[IDENTITY]!.channels[KEY]!, unread: 3 },
          },
        },
      },
    }));
    // Another device advances the read cursor — clears as before.
    store.applyConversation(IDENTITY, channelConversation(80));
    expect(channelState()?.unread).toBe(0);
  });

  it("keeps a DM unread when the ack echo trails a live message", () => {
    const store = useSessionsStore.getState();
    store.applyConversation(IDENTITY, pmConversation("Nyx Firemane"));
    store.bumpUnread(IDENTITY, CONV, 205);
    store.applyConversation(IDENTITY, {
      ...pmConversation("Nyx Firemane"),
      lastReadMessageId: 200,
    });
    expect(useSessionsStore.getState().sessions[IDENTITY]?.dms[CONV]?.unread).toBe(
      1,
    );
  });
});

describe("case-insensitive member-set moves (#265)", () => {
  beforeEach(() => {
    useSessionsStore.getState().applyChannelMembers(IDENTITY, {
      key: KEY,
      mode: "chat",
      members: [member("Amber Vale"), member("Nyx Firemane")],
    });
  });

  it("moves a member to seen on an FLN whose casing differs from the roster", () => {
    useSessionsStore
      .getState()
      .applyPresence(IDENTITY, { character: "NYX FIREMANE", online: false });
    const channel = channelState();
    // No ghost left behind in the live list.
    expect(channel?.members.map((m) => m.character)).toEqual(["Amber Vale"]);
    expect(channel?.seen[0]?.character).toBe("Nyx Firemane");
  });

  it("dedupes a rejoin whose casing differs — never two rows", () => {
    useSessionsStore
      .getState()
      .applyMemberJoin(IDENTITY, KEY, member("NYX firemane"));
    const names = channelState()?.members.map((m) => m.character) ?? [];
    expect(names.filter((n) => n.toLowerCase() === "nyx firemane")).toHaveLength(
      1,
    );
  });

  it("folds a live presence update onto the differently-cased member", () => {
    useSessionsStore.getState().applyPresence(IDENTITY, {
      character: "nyx firemane",
      online: true,
      status: "away",
    });
    const nyx = channelState()?.members.find(
      (m) => m.character === "Nyx Firemane",
    );
    expect(nyx?.status).toBe("away");
  });
});
