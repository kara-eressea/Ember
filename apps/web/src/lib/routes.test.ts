import { beforeEach, describe, expect, it, vi } from "vitest";
import { PREFS_DEFAULTS } from "@emberchat/protocol";
import type { IdentitySession, IdentitySummary } from "../stores/sessions.js";
import {
  channelPath,
  dmPath,
  identityPath,
  rememberLastIdentity,
  resolveConv,
  resolveIdentity,
} from "./routes.js";

// Node test environment — the @me alias reads localStorage.
const stored = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (key: string) => stored.get(key) ?? null,
  setItem: (key: string, value: string) => void stored.set(key, value),
  clear: () => {
    stored.clear();
  },
});

const KARA: IdentitySummary = {
  id: "11111111-1111-7111-8111-111111111111",
  name: "Kara Eressea",
  autoConnect: true,
  unread: 0,
  mentions: 0,
};
const AMBER: IdentitySummary = {
  ...KARA,
  id: "22222222-2222-7222-8222-222222222222",
  name: "Amber Vale",
};
const IDENTITIES = [KARA, AMBER];

function session(): IdentitySession {
  return {
    identityId: KARA.id,
    character: KARA.name,
    sessionStatus: "online",
    ownStatus: "online",
    ownStatusmsg: "",
    ignores: [],
    invites: [],
    limits: { chatMax: 4096, privMax: 50000, lfrpMax: 50000, lfrpFlood: 600 },
    iconBlacklist: [],
    chatop: false,
    sendDelaySeconds: 0,
    prefs: PREFS_DEFAULTS,
    outbox: [],
    channels: {
      Frontpage: {
        convId: "c-1",
        key: "Frontpage",
        title: "Frontpage",
        description: "",
        mode: "both",
        oplist: [],
        members: [],
        joined: true,
        pinned: false,
        unread: 0,
        mentions: 0,
        highlightedAt: 0,
        lastReadMessageId: null,
      },
      "ADH-abc123": {
        convId: "c-2",
        key: "ADH-abc123",
        title: "Secret Room",
        description: "",
        mode: "both",
        oplist: [],
        members: [],
        joined: true,
        pinned: false,
        unread: 0,
        mentions: 0,
        highlightedAt: 0,
        lastReadMessageId: null,
      },
    },
    dms: {
      "d-1": {
        convId: "d-1",
        partner: "Nyx Firemane",
        title: "Nyx Firemane",
        online: true,
        status: "online",
        statusmsg: "",
        pinned: false,
        typing: "clear",
        unread: 0,
        highlightedAt: 0,
        lastReadMessageId: null,
      },
    },
    channelByConvId: { "c-1": "Frontpage", "c-2": "ADH-abc123" },
    synced: true,
  };
}

beforeEach(() => {
  localStorage.clear();
});

describe("path builders", () => {
  it("encode spaces, F-List profile-URL style", () => {
    expect(identityPath("Kara Eressea")).toBe("/app/Kara%20Eressea");
    expect(channelPath("Kara Eressea", "Sci-fi Lounge")).toBe(
      "/app/Kara%20Eressea/c/Sci-fi%20Lounge",
    );
    expect(dmPath("Kara Eressea", "Nyx Firemane")).toBe(
      "/app/Kara%20Eressea/dm/Nyx%20Firemane",
    );
  });
});

describe("resolveIdentity", () => {
  it("matches character names case-insensitively", () => {
    expect(resolveIdentity(IDENTITIES, "kara eressea")).toBe(KARA);
    expect(resolveIdentity(IDENTITIES, "AMBER VALE")).toBe(AMBER);
    expect(resolveIdentity(IDENTITIES, "Nobody")).toBeUndefined();
  });

  it("resolves legacy UUID slugs", () => {
    expect(resolveIdentity(IDENTITIES, AMBER.id)).toBe(AMBER);
  });

  it("@me is the last-active identity, first identity as fallback", () => {
    expect(resolveIdentity(IDENTITIES, "@me")).toBe(KARA);
    rememberLastIdentity(AMBER.id);
    expect(resolveIdentity(IDENTITIES, "@me")).toBe(AMBER);
    // A remembered identity that no longer exists falls back too.
    rememberLastIdentity("33333333-3333-7333-8333-333333333333");
    expect(resolveIdentity(IDENTITIES, "@me")).toBe(KARA);
  });
});

describe("resolveConv", () => {
  it("channels resolve by key, case-insensitively, with canonical suffix", () => {
    expect(resolveConv(session(), { kind: "c", target: "frontpage" })).toEqual({
      convId: "c-1",
      suffix: "c/Frontpage",
    });
    expect(resolveConv(session(), { kind: "c", target: "adh-ABC123" })).toEqual(
      { convId: "c-2", suffix: "c/ADH-abc123" },
    );
    expect(
      resolveConv(session(), { kind: "c", target: "Nowhere" }),
    ).toBeUndefined();
  });

  it("DMs resolve by partner with encoded canonical suffix", () => {
    expect(
      resolveConv(session(), { kind: "dm", target: "nyx firemane" }),
    ).toEqual({ convId: "d-1", suffix: "dm/Nyx%20Firemane" });
  });

  it("legacy conversation ids resolve to their name path", () => {
    expect(resolveConv(session(), { kind: "legacy", convId: "c-1" })).toEqual({
      convId: "c-1",
      suffix: "c/Frontpage",
    });
    expect(resolveConv(session(), { kind: "legacy", convId: "d-1" })).toEqual({
      convId: "d-1",
      suffix: "dm/Nyx%20Firemane",
    });
    expect(
      resolveConv(session(), { kind: "legacy", convId: "gone" }),
    ).toBeUndefined();
  });
});
