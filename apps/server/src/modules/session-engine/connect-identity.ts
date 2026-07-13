// The one place that knows how to connect an identity (decisions.md §9):
// shared by the gateway `session.connect` cmd and the REST connect route so
// the scenario rules never drift between them.

import { eq } from "drizzle-orm";
import type { Db } from "../../db/index.js";
import { identities } from "../../db/schema.js";
import type { HistorySink } from "../history/sink.js";
import type { FchatSession } from "./fchat-session.js";
import type { SessionRegistry } from "./registry.js";

export interface ConnectIdentityDeps {
  readonly db: Db;
  readonly sessions: SessionRegistry;
  readonly history: HistorySink;
}

export interface ConnectIdentityParams {
  readonly identityId: string;
  readonly character: string;
  readonly accountId: string;
  readonly accountName: string;
}

/**
 * Which §9 scenario this connect is depends on the autoConnect flag at the
 * moment of connecting: true means the user never logged this identity off —
 * the stopped session is an outage or restart, so restore the exact channels
 * (scenario 2, seed from `joined`, non-destructive). False means they
 * explicitly logged off earlier and this is the deliberate return —
 * scenario 3, pinned seed, with the destructive joined-flag reconcile
 * deferred until the session actually reaches online (a connect that dies on
 * a locked vault must leave the recovery set intact). A connect while the
 * session already runs never reseeds a live channel set (the registry
 * ignores the seed then).
 *
 * Sets autoConnect = true; the caller is responsible for fanning out the
 * `identity.updated` event (it owns the hub).
 */
export async function connectIdentity(
  deps: ConnectIdentityDeps,
  params: ConnectIdentityParams,
): Promise<FchatSession> {
  const existing = deps.sessions.get(params.identityId);
  const fresh = !existing || existing.status === "stopped";
  let explicitReturn = false;
  let seed: string[] = [];
  if (fresh) {
    const [row] = await deps.db
      .select({ autoConnect: identities.autoConnect })
      .from(identities)
      .where(eq(identities.id, params.identityId));
    explicitReturn = row?.autoConnect === false;
    seed = explicitReturn
      ? await deps.history.pinnedChannelKeys(params.identityId)
      : await deps.history.channelsForResume(params.identityId);
  }
  const session = deps.sessions.start({
    identityId: params.identityId,
    character: params.character,
    accountId: params.accountId,
    accountName: params.accountName,
    seedChannels: seed,
  });
  if (fresh && explicitReturn) {
    const off = session.events.on("status", (event) => {
      if (event.status === "online") {
        off();
        deps.history.reconcileJoinedForConnect(params.identityId);
      } else if (event.status === "stopped") {
        off();
      }
    });
  }
  await deps.db
    .update(identities)
    .set({ autoConnect: true })
    .where(eq(identities.id, params.identityId));
  return session;
}
