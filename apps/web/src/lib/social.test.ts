// loadSocial semantics (M6 audit): plain loads single-flight; a FORCED
// refresh never joins a stale in-flight load — it chains a fresh fetch
// behind it, so "mutate, then refresh" can't render pre-mutation lists.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { PREFS_DEFAULTS } from "@emberchat/protocol";
import type { IdentitySession } from "../stores/sessions.js";
import { useSessionsStore } from "../stores/sessions.js";
import { api, type SocialDto } from "./api.js";
import { loadSocial } from "./social.js";

const ID = "11111111-1111-4111-8111-111111111111";

function slice(): IdentitySession {
  return {
    identityId: ID,
    character: "Amber Vale",
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
    campaign: null,
    channels: {},
    dms: {},
    channelByConvId: {},
    synced: true,
  };
}

function dto(marker: string): SocialDto {
  return {
    bookmarks: [
      { name: marker, online: false, status: "offline", statusmsg: "" },
    ],
    friends: [],
    incoming: [],
    outgoing: [],
  };
}

beforeEach(() => {
  useSessionsStore.setState({ sessions: { [ID]: slice() } });
  vi.restoreAllMocks();
});

describe("loadSocial", () => {
  it("chains a forced refresh behind an in-flight load instead of joining it", async () => {
    let releaseFirst!: (value: SocialDto) => void;
    const first = new Promise<SocialDto>((resolve) => {
      releaseFirst = resolve;
    });
    const spy = vi
      .spyOn(api, "getSocial")
      .mockReturnValueOnce(first)
      .mockResolvedValueOnce(dto("post-mutation"));

    const initial = loadSocial(ID); // slow initial load in flight
    const forced = loadSocial(ID, true); // e.g. right after a bookmark add
    expect(spy).toHaveBeenCalledTimes(1); // second fetch waits its turn

    releaseFirst(dto("pre-mutation"));
    await initial;
    await forced;
    expect(spy).toHaveBeenCalledTimes(2);
    // The forced refresh's (fresh) result is what sticks.
    expect(
      useSessionsStore.getState().sessions[ID]?.social?.bookmarks[0]?.name,
    ).toBe("post-mutation");
  });

  it("plain loads reuse the cached lists and the in-flight promise", async () => {
    const spy = vi.spyOn(api, "getSocial").mockResolvedValue(dto("only"));
    await Promise.all([loadSocial(ID), loadSocial(ID)]);
    await loadSocial(ID); // cached now
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
