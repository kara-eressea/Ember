import { createServer } from "node:net";

/**
 * The only interface the embedded server is ever allowed to bind
 * (mx3-desktop-shell.md invariant 3). Exported as a constant so no call site
 * can quietly type something else.
 */
export const LOOPBACK_HOST = "127.0.0.1";

/** `http://127.0.0.1:<port>` — the app origin, in exactly one spelling. */
export function loopbackOrigin(port: number): string {
  return `http://${LOOPBACK_HOST}:${String(port)}`;
}

/**
 * A free TCP port on loopback: bind port 0, read what the kernel handed out,
 * close. The gap between close and the server's own bind is a race the whole
 * industry accepts — the alternative (handing a listening socket to the child)
 * buys nothing here, because the child is Fastify and wants a port number.
 */
export async function findFreePort(
  host: string = LOOPBACK_HOST,
): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen({ host, port: 0 }, () => {
      const address = probe.address();
      if (address === null || typeof address === "string") {
        probe.close();
        reject(new Error(`could not read a port from a ${host} probe socket`));
        return;
      }
      const { port } = address;
      probe.close((error) => {
        if (error) {
          reject(error);
        } else {
          resolve(port);
        }
      });
    });
  });
}
