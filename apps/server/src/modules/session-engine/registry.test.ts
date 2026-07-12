// SessionRegistry against fchat-sim, through the real vault → ticket
// registry → FlistApiClient chain (two identities on one account share a
// TicketManager, so starting both must not churn tickets).

import { afterEach, describe, expect, it } from "vitest";
import { FchatSim } from "@emberline/fchat-sim";
import { FlistApiClient } from "../flist-api/api-client.js";
import { TicketManagerRegistry } from "../flist-api/ticket-manager.js";
import { CredentialVault } from "../flist-accounts/vault.js";
import type { FchatSession } from "./fchat-session.js";
import { SessionRegistry } from "./registry.js";
import type { SessionStatus } from "./session-state.js";

const ACCOUNT = "amber@example.test";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

async function makeRegistry(): Promise<{
  sim: FchatSim;
  registry: SessionRegistry;
}> {
  const sim = new FchatSim();
  await sim.start();
  cleanups.push(() => sim.stop());

  const vault = new CredentialVault();
  vault.set("acc-1", "hunter2");
  const tickets = new TicketManagerRegistry(
    new FlistApiClient({ baseUrl: sim.httpUrl, minRequestIntervalMs: 0 }),
    vault,
  );
  const registry = new SessionRegistry({
    tickets,
    wsUrl: sim.wsUrl,
    clientName: "Emberline-test",
    clientVersion: "0.0.0",
  });
  cleanups.push(() => {
    registry.stopAll();
  });
  return { sim, registry };
}

function waitForStatus(
  session: FchatSession,
  status: SessionStatus,
  timeoutMs = 5000,
): Promise<void> {
  if (session.status === status) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      off();
      reject(
        new Error(
          `timed out waiting for ${status} (currently ${session.status})`,
        ),
      );
    }, timeoutMs);
    const off = session.events.on("status", (event) => {
      if (event.status === status) {
        clearTimeout(timer);
        off();
        resolve();
      }
    });
  });
}

const amber = {
  identityId: "id-amber",
  character: "Amber Vale",
  accountId: "acc-1",
  accountName: ACCOUNT,
};
const cindral = {
  identityId: "id-cindral",
  character: "Cindral",
  accountId: "acc-1",
  accountName: ACCOUNT,
};

describe("SessionRegistry", () => {
  it("starts a session and returns the same instance while it runs", async () => {
    const { registry } = await makeRegistry();
    const session = registry.start(amber);
    expect(registry.get(amber.identityId)).toBe(session);
    expect(registry.start(amber)).toBe(session);
    await waitForStatus(session, "online");
    expect(session.state.ownCharacter).toBe("Amber Vale");
  });

  it("runs two identities of one account through the shared ticket manager", async () => {
    const { registry } = await makeRegistry();
    const first = registry.start(amber);
    const second = registry.start(cindral);
    expect(second).not.toBe(first);
    await Promise.all([
      waitForStatus(first, "online"),
      waitForStatus(second, "online"),
    ]);
    // Both are online — the coalesced/cached ticket did not get churned.
    expect(first.status).toBe("online");
    expect(second.status).toBe("online");
  });

  it("replaces a stopped session on the next start", async () => {
    const { registry } = await makeRegistry();
    const first = registry.start(amber);
    await waitForStatus(first, "online");
    first.stop();

    const second = registry.start(amber);
    expect(second).not.toBe(first);
    expect(registry.get(amber.identityId)).toBe(second);
    await waitForStatus(second, "online");
  });

  it("stop() forgets the session; stopAll() sweeps the rest", async () => {
    const { registry } = await makeRegistry();
    const first = registry.start(amber);
    const second = registry.start(cindral);
    await Promise.all([
      waitForStatus(first, "online"),
      waitForStatus(second, "online"),
    ]);

    registry.stop(amber.identityId);
    expect(first.status).toBe("stopped");
    expect(registry.get(amber.identityId)).toBeUndefined();
    expect(second.status).toBe("online");

    registry.stopAll();
    expect(second.status).toBe("stopped");
    expect(registry.get(cindral.identityId)).toBeUndefined();
  });
});
