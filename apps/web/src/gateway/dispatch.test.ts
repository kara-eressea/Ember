// The protocol surface, exercised the way the socket does it: server frames
// through dispatchFrame() into the stores. Volatile events are at-least-once
// (gateway contract), so the interesting cases are the idempotent ones —
// duplicate joins, FLN as a global leave, unread convergence.

import { beforeEach, describe, expect, it } from "vitest";
import type { MessageDto, ServerFrame } from "@emberchat/protocol";
import { useMessagesStore } from "../stores/messages.js";
import { useSessionsStore } from "../stores/sessions.js";
import { useUiStore } from "../stores/ui.js";
import { dispatchFrame } from "./dispatch.js";

const IDENTITY = "11111111-1111-7111-8111-111111111111";
const CONV_CHANNEL = "22222222-2222-7222-8222-222222222222";
const CONV_DM = "33333333-3333-7333-8333-333333333333";

function member(character: string, status = "online") {
  return { character, gender: "None", status, statusmsg: "" };
}

function message(id: number, overrides: Partial<MessageDto> = {}): MessageDto {
  return {
    id,
    senderCharacter: "Nyx Firemane",
    kind: "msg",
    bbcode: `message ${String(id)}`,
    sentByUs: false,
    createdAt: "2026-07-13T12:00:00.000Z",
    ...overrides,
  };
}

function event(kind: string, d: unknown): ServerFrame {
  return {
    t: "event",
    d: { identityId: IDENTITY, kind, d },
  } as ServerFrame;
}

function snapshot(): ServerFrame {
  return {
    t: "snapshot",
    d: {
      identityId: IDENTITY,
      self: {
        character: "Amber Vale",
        sessionStatus: "online",
        status: "online",
        statusmsg: "",
        ignores: [],
        limits: { chatMax: 4096, privMax: 50000 },
      },
      channels: [
        {
          convId: CONV_CHANNEL,
          key: "Frontpage",
          title: "Frontpage",
          description: "The hangout.",
          mode: "chat",
          oplist: ["", "Nyx Firemane"],
          members: [member("Amber Vale"), member("Nyx Firemane")],
          joined: true,
          pinned: false,
          unread: 3,
          mentions: 1,
          lastReadMessageId: 10,
        },
      ],
      dms: [
        {
          convId: CONV_DM,
          partner: "Nyx Firemane",
          title: "Nyx Firemane",
          online: true,
          status: "online",
          statusmsg: "",
          pinned: false,
          unread: 0,
          lastReadMessageId: null,
        },
      ],
    },
  };
}

beforeEach(() => {
  useSessionsStore.getState().reset();
  useMessagesStore.getState().reset();
  useUiStore.getState().setActive(undefined, undefined);
});

function session() {
  const state = useSessionsStore.getState().sessions[IDENTITY];
  if (!state) {
    throw new Error("no session in store");
  }
  return state;
}

describe("snapshot", () => {
  it("populates channels, dms and self", () => {
    dispatchFrame(snapshot());
    const s = session();
    expect(s.synced).toBe(true);
    expect(s.character).toBe("Amber Vale");
    expect(s.sessionStatus).toBe("online");
    expect(s.channels["Frontpage"]?.unread).toBe(3);
    expect(s.channels["Frontpage"]?.mentions).toBe(1);
    expect(s.channelByConvId[CONV_CHANNEL]).toBe("Frontpage");
    expect(s.dms[CONV_DM]?.partner).toBe("Nyx Firemane");
  });

  it("replaces volatile state wholesale on re-sub", () => {
    dispatchFrame(snapshot());
    dispatchFrame(
      event("member.join", {
        channelKey: "Frontpage",
        member: member("Tally Marsh"),
      }),
    );
    expect(session().channels["Frontpage"]?.members).toHaveLength(3);
    dispatchFrame(snapshot());
    expect(session().channels["Frontpage"]?.members).toHaveLength(2);
  });
});

describe("member events", () => {
  it("treats member lists as sets — duplicate joins are no-ops", () => {
    dispatchFrame(snapshot());
    const join = event("member.join", {
      channelKey: "Frontpage",
      member: member("Tally Marsh"),
    });
    dispatchFrame(join);
    dispatchFrame(join); // at-least-once replay around a snapshot
    expect(
      session().channels["Frontpage"]?.members.filter(
        (m) => m.character === "Tally Marsh",
      ),
    ).toHaveLength(1);
  });

  it("removes a leaver; our own leave clears the live list", () => {
    dispatchFrame(snapshot());
    dispatchFrame(
      event("member.leave", {
        channelKey: "Frontpage",
        character: "Nyx Firemane",
      }),
    );
    expect(
      session().channels["Frontpage"]?.members.map((m) => m.character),
    ).toEqual(["Amber Vale"]);
    dispatchFrame(
      event("member.leave", {
        channelKey: "Frontpage",
        character: "Amber Vale",
      }),
    );
    expect(session().channels["Frontpage"]?.members).toEqual([]);
  });

  it("applies ICH as a full overwrite", () => {
    dispatchFrame(snapshot());
    dispatchFrame(
      event("channel.members", {
        key: "Frontpage",
        mode: "both",
        members: [member("Old Greywhisker")],
      }),
    );
    const channel = session().channels["Frontpage"];
    expect(channel?.mode).toBe("both");
    expect(channel?.members.map((m) => m.character)).toEqual([
      "Old Greywhisker",
    ]);
  });

  it("keeps volatile events that beat the conversation row (join race)", () => {
    // ICH/CDS fan out from the session bus while the sink is still writing
    // the conversation — they must create the channel, not be dropped.
    dispatchFrame(snapshot());
    dispatchFrame(
      event("channel.members", {
        key: "Development",
        mode: "both",
        members: [member("Amber Vale"), member("Tally Marsh")],
      }),
    );
    dispatchFrame(
      event("channel.info", {
        key: "Development",
        description: "Talk about third-party clients here.",
      }),
    );
    const placeholder = session().channels["Development"];
    expect(placeholder?.convId).toBe("");
    expect(placeholder?.members).toHaveLength(2);

    const convId = "55555555-5555-7555-8555-555555555555";
    dispatchFrame(
      event("conversation.updated", {
        conversation: {
          id: convId,
          kind: "channel",
          channelKey: "Development",
          partnerCharacter: null,
          title: "Development",
          pinned: false,
          joined: true,
          lastReadMessageId: null,
        },
      }),
    );
    const channel = session().channels["Development"];
    expect(channel?.convId).toBe(convId);
    expect(channel?.joined).toBe(true);
    expect(channel?.description).toBe("Talk about third-party clients here.");
    expect(channel?.members).toHaveLength(2);
    expect(session().channelByConvId[convId]).toBe("Development");
  });
});

describe("presence", () => {
  it("FLN is a global leave and flips the DM row offline", () => {
    dispatchFrame(snapshot());
    dispatchFrame(
      event("presence", { character: "Nyx Firemane", online: false }),
    );
    const s = session();
    expect(
      s.channels["Frontpage"]?.members.some(
        (m) => m.character === "Nyx Firemane",
      ),
    ).toBe(false);
    expect(s.dms[CONV_DM]?.online).toBe(false);
  });

  it("matches DM partners case-insensitively (PM merge semantics)", () => {
    dispatchFrame(snapshot());
    dispatchFrame(
      event("presence", {
        character: "NYX FIREMANE",
        online: true,
        status: "busy",
        statusmsg: "Lurking.",
      }),
    );
    expect(session().dms[CONV_DM]?.status).toBe("busy");
  });

  it("presence.bulk (LIS roster) brings DM partners online, case-insensitively", () => {
    dispatchFrame(snapshot());
    dispatchFrame(
      event("presence", { character: "Nyx Firemane", online: false }),
    );
    expect(session().dms[CONV_DM]?.online).toBe(false);
    dispatchFrame(
      event("presence.bulk", {
        characters: [
          ["Somebody Else", "None", "online", ""],
          ["NYX FIREMANE", "Female", "looking", "Open!"],
        ],
      }),
    );
    const dm = session().dms[CONV_DM];
    expect(dm?.online).toBe(true);
    expect(dm?.status).toBe("looking");
    expect(dm?.statusmsg).toBe("Open!");
    // The snapshot carried the live limits too.
    expect(session().limits).toEqual({ chatMax: 4096, privMax: 50000 });
  });

  it("ignore.updated overwrites the ignore list", () => {
    dispatchFrame(snapshot());
    expect(session().ignores).toEqual([]);
    dispatchFrame(
      event("ignore.updated", { characters: ["Nyx Firemane", "Tally Marsh"] }),
    );
    expect(session().ignores).toEqual(["Nyx Firemane", "Tally Marsh"]);
    dispatchFrame(event("ignore.updated", { characters: [] }));
    expect(session().ignores).toEqual([]);
  });

  it("our own STA converges the MeBar/rail status", () => {
    dispatchFrame(snapshot());
    dispatchFrame(
      event("presence", {
        character: "AMBER VALE", // self, any casing
        online: true,
        status: "away",
        statusmsg: "brb tea",
      }),
    );
    expect(session().ownStatus).toBe("away");
    expect(session().ownStatusmsg).toBe("brb tea");
    // Someone else's presence never touches our own status.
    dispatchFrame(
      event("presence", {
        character: "Nyx Firemane",
        online: true,
        status: "busy",
      }),
    );
    expect(session().ownStatus).toBe("away");
  });
});

describe("message.new and unread", () => {
  it("appends to the buffer and bumps unread for inactive conversations", () => {
    dispatchFrame(snapshot());
    dispatchFrame(
      event("message.new", { convId: CONV_CHANNEL, message: message(11) }),
    );
    expect(
      useMessagesStore.getState().buffers[CONV_CHANNEL]?.messages,
    ).toHaveLength(1);
    expect(session().channels["Frontpage"]?.unread).toBe(4);
  });

  it("does not bump unread for the active conversation or our own sends", () => {
    dispatchFrame(snapshot());
    useUiStore.getState().setActive(IDENTITY, CONV_CHANNEL);
    dispatchFrame(
      event("message.new", { convId: CONV_CHANNEL, message: message(11) }),
    );
    expect(session().channels["Frontpage"]?.unread).toBe(3);

    useUiStore.getState().setActive(undefined, undefined);
    dispatchFrame(
      event("message.new", {
        convId: CONV_CHANNEL,
        message: message(12, { sentByUs: true }),
      }),
    );
    expect(session().channels["Frontpage"]?.unread).toBe(3);
  });

  it("bumps mentions when an inbound channel message names our character", () => {
    dispatchFrame(snapshot());
    dispatchFrame(
      event("message.new", {
        convId: CONV_CHANNEL,
        message: message(11, { bbcode: "ping Amber Vale, you around?" }),
      }),
    );
    // Word boundary: a longer name containing ours does not count.
    dispatchFrame(
      event("message.new", {
        convId: CONV_CHANNEL,
        message: message(12, { bbcode: "Amber Valery sends regards" }),
      }),
    );
    // Our own message naming ourselves does not count.
    dispatchFrame(
      event("message.new", {
        convId: CONV_CHANNEL,
        message: message(13, {
          bbcode: "I am Amber Vale",
          sentByUs: true,
        }),
      }),
    );
    const channel = session().channels["Frontpage"];
    expect(channel?.mentions).toBe(2); // 1 from the snapshot + 1 live
    expect(channel?.unread).toBe(5);
  });

  it("identity.updated converges the autoConnect mirror across tabs", () => {
    dispatchFrame({
      t: "ready",
      d: {
        userId: "user-1",
        identities: [
          {
            id: IDENTITY,
            name: "Amber Vale",
            sessionStatus: "online",
            autoConnect: true,
            unread: 3,
            mentions: 1,
          },
        ],
      },
    });
    // Ready-time badge totals land on the summary (the rail's initial paint).
    expect(
      useSessionsStore.getState().identities?.find((i) => i.id === IDENTITY),
    ).toMatchObject({ unread: 3, mentions: 1 });
    dispatchFrame(event("identity.updated", { autoConnect: false }));
    expect(
      useSessionsStore.getState().identities?.find((i) => i.id === IDENTITY)
        ?.autoConnect,
    ).toBe(false);
  });

  it("identities.reordered re-sorts the rail, keeping unknown ids at the end", () => {
    const summary = (id: string, name: string) => ({
      id,
      name,
      sessionStatus: "online" as const,
      autoConnect: true,
      unread: 0,
      mentions: 0,
    });
    dispatchFrame({
      t: "ready",
      d: {
        userId: "user-1",
        identities: [summary("a", "A"), summary("b", "B"), summary("c", "C")],
      },
    });
    // Order from a tab that never saw "c" (created after its list) — the
    // stragglers keep their place at the end instead of vanishing.
    dispatchFrame(event("identities.reordered", { order: ["b", "a"] }));
    expect(useSessionsStore.getState().identities?.map((i) => i.id)).toEqual([
      "b",
      "a",
      "c",
    ]);
  });

  it("an advanced read cursor (any tab's ack) zeroes the badge", () => {
    dispatchFrame(snapshot());
    dispatchFrame(
      event("conversation.updated", {
        conversation: {
          id: CONV_CHANNEL,
          kind: "channel",
          channelKey: "Frontpage",
          partnerCharacter: null,
          title: "Frontpage",
          pinned: false,
          joined: true,
          lastReadMessageId: 13,
        },
      }),
    );
    expect(session().channels["Frontpage"]?.unread).toBe(0);
  });

  it("a pm conversation row materializes from its creation event", () => {
    dispatchFrame(snapshot());
    const convId = "44444444-4444-7444-8444-444444444444";
    dispatchFrame(
      event("conversation.updated", {
        conversation: {
          id: convId,
          kind: "pm",
          channelKey: null,
          partnerCharacter: "Birch Rowan",
          title: "Birch Rowan",
          pinned: false,
          joined: false,
          lastReadMessageId: null,
        },
      }),
    );
    dispatchFrame(
      event("message.new", {
        convId,
        message: message(20, { kind: "pm", senderCharacter: "Birch Rowan" }),
      }),
    );
    const dm = session().dms[convId];
    expect(dm?.partner).toBe("Birch Rowan");
    expect(dm?.unread).toBe(1);
  });
});

describe("catchup", () => {
  it("appends without touching unread (snapshot already counted it)", () => {
    dispatchFrame(snapshot());
    dispatchFrame({
      t: "catchup",
      d: {
        identityId: IDENTITY,
        convId: CONV_CHANNEL,
        messages: [message(11), message(12)],
        done: true,
      },
    });
    expect(
      useMessagesStore.getState().buffers[CONV_CHANNEL]?.messages,
    ).toHaveLength(2);
    expect(session().channels["Frontpage"]?.unread).toBe(3);
  });
});
