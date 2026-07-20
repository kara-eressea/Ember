// The protocol surface, exercised the way the socket does it: server frames
// through dispatchFrame() into the stores. Volatile events are at-least-once
// (gateway contract), so the interesting cases are the idempotent ones —
// duplicate joins, FLN as a global leave, unread convergence.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { PREFS_DEFAULTS } from "@emberchat/protocol";
import type { MessageDto, ServerFrame } from "@emberchat/protocol";
import { useMessagesStore } from "../stores/messages.js";
import { useSessionsStore } from "../stores/sessions.js";
import { useUiStore } from "../stores/ui.js";

// Node environment — hydrateTheme writes to document/localStorage, and the
// when-highlighted actions touch Audio/document.title.
vi.mock("../theme/theme.js", () => ({ hydrateTheme: vi.fn() }));
vi.mock("../lib/highlight-notify.js", () => ({
  playHighlightChime: vi.fn(),
  flashTitle: vi.fn(),
  stopTitleFlash: vi.fn(),
}));
vi.mock("../lib/desktop-notify.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/desktop-notify.js")>()),
  showMessageNotification: vi.fn(),
}));
import { showMessageNotification } from "../lib/desktop-notify.js";
import { flashTitle, playHighlightChime } from "../lib/highlight-notify.js";
import { hydrateTheme } from "../theme/theme.js";
import { dispatchFrame, rtbNoticeText } from "./dispatch.js";

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
    mention: false,
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
  vi.mocked(playHighlightChime).mockClear();
  vi.mocked(flashTitle).mockClear();
  vi.mocked(showMessageNotification).mockClear();
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
    expect(session().limits).toEqual({
      chatMax: 4096,
      privMax: 50000,
      lfrpMax: 50000,
      lfrpFlood: 600,
    });
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

  it("outbox.updated and prefs.updated keep the delayed-send state live", () => {
    dispatchFrame(snapshot());
    expect(session().outbox).toEqual([]);
    const item = {
      id: "ob-1",
      convId: "conv-1",
      markdown: "**later**",
      bbcode: "[b]later[/b]",
      releaseAt: "2026-07-14T00:00:10.000Z",
      state: "scheduled",
    };
    dispatchFrame(event("outbox.updated", { items: [item] }));
    expect(session().outbox).toEqual([item]);
    dispatchFrame(event("outbox.updated", { items: [] }));
    expect(session().outbox).toEqual([]);

    dispatchFrame(
      event("prefs.updated", {
        sendDelaySeconds: 30,
        prefs: { ...PREFS_DEFAULTS, accent: "moss" },
      }),
    );
    expect(session().sendDelaySeconds).toBe(30);
    expect(session().prefs.accent).toBe("moss");
  });

  it("synthesizes live-only join/part/quit lines, idempotently", () => {
    dispatchFrame(snapshot());
    const lines = () =>
      (useMessagesStore.getState().buffers[CONV_CHANNEL]?.presence ?? []).map(
        (line) => `${line.kind}:${line.character}`,
      );

    // A newcomer joins → one line; the at-least-once replay (already a
    // member by then) logs nothing.
    dispatchFrame(
      event("member.join", {
        channelKey: "Frontpage",
        member: member("Tally Marsh"),
      }),
    );
    dispatchFrame(
      event("member.join", {
        channelKey: "Frontpage",
        member: member("Tally Marsh"),
      }),
    );
    expect(lines()).toEqual(["join:Tally Marsh"]);

    // Leave → one line; the replay (no longer a member) logs nothing.
    dispatchFrame(
      event("member.leave", {
        channelKey: "Frontpage",
        character: "Tally Marsh",
      }),
    );
    dispatchFrame(
      event("member.leave", {
        channelKey: "Frontpage",
        character: "Tally Marsh",
      }),
    );
    // FLN: a quit line in every channel the character was a member of.
    dispatchFrame(
      event("presence", { character: "Nyx Firemane", online: false }),
    );
    dispatchFrame(
      event("presence", { character: "Nyx Firemane", online: false }),
    );
    expect(lines()).toEqual([
      "join:Tally Marsh",
      "part:Tally Marsh",
      "quit:Nyx Firemane",
    ]);
  });

  it("prefs hydrate the theme (snapshot and live update)", () => {
    vi.mocked(hydrateTheme).mockClear();
    dispatchFrame(snapshot());
    expect(hydrateTheme).toHaveBeenLastCalledWith(PREFS_DEFAULTS);
    const next = { ...PREFS_DEFAULTS, accent: "amber" as const };
    dispatchFrame(event("prefs.updated", { sendDelaySeconds: 0, prefs: next }));
    expect(hydrateTheme).toHaveBeenLastCalledWith(next);
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

  it("bumps mentions from the server-stamped flag, never by re-matching", () => {
    dispatchFrame(snapshot());
    // The persist-time verdict rides the message (M5) — the client trusts it.
    dispatchFrame(
      event("message.new", {
        convId: CONV_CHANNEL,
        message: message(11, {
          bbcode: "ping Amber Vale, you around?",
          mention: true,
        }),
      }),
    );
    // Naming us with mention:false stays a plain unread — no client matcher.
    dispatchFrame(
      event("message.new", {
        convId: CONV_CHANNEL,
        message: message(12, { bbcode: "Amber Vale sends regards" }),
      }),
    );
    // Our own sends never bump, whatever the flag says.
    dispatchFrame(
      event("message.new", {
        convId: CONV_CHANNEL,
        message: message(13, {
          bbcode: "I am Amber Vale",
          sentByUs: true,
          mention: true,
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

describe("when-highlighted actions", () => {
  const mention = (id: number) =>
    event("message.new", {
      convId: CONV_CHANNEL,
      message: message(id, { mention: true }),
    });
  /** prefs.updated with the given when-highlighted switches. */
  const setPrefs = (overrides: Partial<typeof PREFS_DEFAULTS>) =>
    event("prefs.updated", {
      sendDelaySeconds: 0,
      prefs: { ...PREFS_DEFAULTS, ...overrides },
    });

  it("fires each action behind its pref on an inactive mention", () => {
    dispatchFrame(snapshot());
    // Defaults: flash on, sound and bump off.
    dispatchFrame(mention(11));
    expect(flashTitle).toHaveBeenCalledTimes(1);
    expect(playHighlightChime).not.toHaveBeenCalled();
    expect(session().channels["Frontpage"]?.highlightedAt).toBe(0);

    dispatchFrame(
      setPrefs({
        highlightSound: true,
        highlightBump: true,
        highlightFlashTitle: false,
      }),
    );
    dispatchFrame(mention(12));
    expect(flashTitle).toHaveBeenCalledTimes(1); // still just the first
    expect(playHighlightChime).toHaveBeenCalledTimes(1);
    expect(session().channels["Frontpage"]?.highlightedAt).toBeGreaterThan(0);
  });

  it("stays silent for the active conversation, own sends, and non-mentions", () => {
    dispatchFrame(snapshot());
    dispatchFrame(setPrefs({ highlightSound: true, highlightBump: true }));

    useUiStore.getState().setActive(IDENTITY, CONV_CHANNEL);
    dispatchFrame(mention(11));

    useUiStore.getState().setActive(undefined, undefined);
    dispatchFrame(
      event("message.new", {
        convId: CONV_CHANNEL,
        message: message(12, { mention: true, sentByUs: true }),
      }),
    );
    dispatchFrame(
      event("message.new", { convId: CONV_CHANNEL, message: message(13) }),
    );

    expect(flashTitle).not.toHaveBeenCalled();
    expect(playHighlightChime).not.toHaveBeenCalled();
    expect(session().channels["Frontpage"]?.highlightedAt).toBe(0);
  });

  it("clearUnread drops the bump stamp along with the badges", () => {
    dispatchFrame(snapshot());
    dispatchFrame(setPrefs({ highlightBump: true }));
    dispatchFrame(mention(11));
    expect(session().channels["Frontpage"]?.highlightedAt).toBeGreaterThan(0);
    useSessionsStore.getState().clearUnread(IDENTITY, CONV_CHANNEL);
    const channel = session().channels["Frontpage"];
    expect(channel?.highlightedAt).toBe(0);
    expect(channel?.unread).toBe(0);
    expect(channel?.mentions).toBe(0);
  });
});

describe("desktop notifications and mutes", () => {
  const setPrefs = (overrides: Partial<typeof PREFS_DEFAULTS>) =>
    event("prefs.updated", {
      sendDelaySeconds: 0,
      prefs: { ...PREFS_DEFAULTS, ...overrides },
    });

  it("notifies on a mention with a stripped preview, titled with the channel", () => {
    dispatchFrame(snapshot());
    dispatchFrame(setPrefs({ desktopNotifyMentions: true }));
    dispatchFrame(
      event("message.new", {
        convId: CONV_CHANNEL,
        message: message(11, {
          bbcode: "[b]Amber Vale[/b], look at this",
          mention: true,
        }),
      }),
    );
    expect(showMessageNotification).toHaveBeenCalledWith({
      title: "Nyx Firemane — Frontpage",
      body: "Amber Vale, look at this",
      tag: CONV_CHANNEL,
    });
    // A plain message is not a mention — no notification.
    dispatchFrame(
      event("message.new", { convId: CONV_CHANNEL, message: message(12) }),
    );
    expect(showMessageNotification).toHaveBeenCalledTimes(1);
  });

  it("notifies on PMs behind their own pref, titled with the sender", () => {
    dispatchFrame(snapshot());
    const pm = (id: number) =>
      event("message.new", {
        convId: CONV_DM,
        message: message(id, { kind: "pm", bbcode: "hey there" }),
      });
    dispatchFrame(pm(11));
    expect(showMessageNotification).not.toHaveBeenCalled();
    dispatchFrame(setPrefs({ desktopNotifyPms: true }));
    dispatchFrame(pm(12));
    expect(showMessageNotification).toHaveBeenCalledWith({
      title: "Nyx Firemane",
      body: "hey there",
      tag: CONV_DM,
    });
  });

  it("omits the body when the preview pref is off", () => {
    dispatchFrame(snapshot());
    dispatchFrame(
      setPrefs({ desktopNotifyPms: true, notifyShowContent: false }),
    );
    dispatchFrame(
      event("message.new", {
        convId: CONV_DM,
        message: message(11, { kind: "pm", bbcode: "secret plans" }),
      }),
    );
    expect(showMessageNotification).toHaveBeenCalledWith({
      title: "Nyx Firemane",
      tag: CONV_DM,
    });
  });

  it("mutes silence alerts only — badges, tint source and bump still accrue", () => {
    dispatchFrame(snapshot());
    dispatchFrame(
      setPrefs({
        desktopNotifyMentions: true,
        highlightSound: true,
        highlightFlashTitle: true,
        highlightBump: true,
        mutedConvIds: [CONV_CHANNEL],
      }),
    );
    dispatchFrame(
      event("message.new", {
        convId: CONV_CHANNEL,
        message: message(11, { mention: true }),
      }),
    );
    expect(showMessageNotification).not.toHaveBeenCalled();
    expect(playHighlightChime).not.toHaveBeenCalled();
    expect(flashTitle).not.toHaveBeenCalled();
    const channel = session().channels["Frontpage"];
    expect(channel?.unread).toBe(4);
    expect(channel?.mentions).toBe(2);
    expect(channel?.highlightedAt).toBeGreaterThan(0);
  });

  it("a per-identity mute covers every conversation of the identity", () => {
    dispatchFrame(snapshot());
    dispatchFrame(
      setPrefs({ desktopNotifyPms: true, mutedIdentityIds: [IDENTITY] }),
    );
    dispatchFrame(
      event("message.new", {
        convId: CONV_DM,
        message: message(11, { kind: "pm" }),
      }),
    );
    expect(showMessageNotification).not.toHaveBeenCalled();
    expect(session().dms[CONV_DM]?.unread).toBe(1);
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

describe("rtbNoticeText", () => {
  it("renders notes, friend requests, and comments; stays silent otherwise", () => {
    expect(
      rtbNoticeText({
        type: "note",
        character: "Nyx Firemane",
        subject: "Hello",
      }),
    ).toBe("New note from Nyx Firemane: Hello — read it on f-list.net");
    expect(rtbNoticeText({ type: "note", character: "Nyx Firemane" })).toBe(
      "New note from Nyx Firemane — read it on f-list.net",
    );
    expect(rtbNoticeText({ type: "friendrequest", character: "Tally" })).toBe(
      "Tally sent a friend request",
    );
    expect(rtbNoticeText({ type: "trackadd" })).toBeUndefined();
  });
});

describe("ads.updated", () => {
  it("converges the ad-library mirror for the identity (M10)", async () => {
    const { useAdsStore } = await import("../stores/ads.js");
    expect(useAdsStore.getState().byIdentity[IDENTITY]).toBeUndefined();
    const ads = [
      { id: "a1", content: "hello", tags: ["default"], disabled: false },
    ];
    dispatchFrame(event("ads.updated", { ads }));
    expect(useAdsStore.getState().byIdentity[IDENTITY]).toEqual({
      ads,
      loaded: true,
    });
    // At-least-once: a replay is an idempotent overwrite.
    dispatchFrame(event("ads.updated", { ads: [] }));
    expect(useAdsStore.getState().byIdentity[IDENTITY]?.ads).toEqual([]);
  });
});

describe("ads.cooldowns", () => {
  it("stores waits as absolute expiries (M10)", async () => {
    const { useAdsStore } = await import("../stores/ads.js");
    const before = Date.now();
    dispatchFrame(
      event("ads.cooldowns", { waits: { Development: 60_000, Frontpage: 0 } }),
    );
    const until =
      useAdsStore.getState().cooldownsByIdentity[IDENTITY]?.["Development"];
    expect(until).toBeGreaterThanOrEqual(before + 60_000);
    expect(
      useAdsStore.getState().cooldownsByIdentity[IDENTITY]?.["Frontpage"],
    ).toBeLessThanOrEqual(Date.now());
  });
});
