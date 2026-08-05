import { createServer } from "node:net";
import { describe, expect, it } from "vitest";
import { findFreePort, LOOPBACK_HOST, loopbackOrigin } from "./loopback.js";

describe("loopbackOrigin", () => {
  it("is loopback, always", () => {
    expect(loopbackOrigin(51_000)).toBe("http://127.0.0.1:51000");
    expect(LOOPBACK_HOST).toBe("127.0.0.1");
  });
});

describe("findFreePort", () => {
  it("returns a port that can then be bound", async () => {
    const port = await findFreePort();
    expect(port).toBeGreaterThan(0);
    expect(port).toBeLessThanOrEqual(65_535);

    // The probe must have released it — that is the whole contract.
    await new Promise<void>((resolve, reject) => {
      const server = createServer();
      server.once("error", reject);
      server.listen({ host: LOOPBACK_HOST, port }, () => {
        server.close(() => {
          resolve();
        });
      });
    });
  });

  it("does not hand out the same port twice in a row", async () => {
    // Not a guarantee the kernel makes, but a regression net for the obvious
    // bug: a probe that never actually listens returns 0 every time.
    const ports = await Promise.all([
      findFreePort(),
      findFreePort(),
      findFreePort(),
    ]);
    expect(new Set(ports).size).toBe(3);
  });

  it("rejects rather than hangs when the host cannot be bound", async () => {
    await expect(findFreePort("240.0.0.1")).rejects.toThrow();
  });
});
