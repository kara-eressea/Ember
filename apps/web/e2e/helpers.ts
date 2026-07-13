// Shared E2E plumbing: avatar interception (no real f-list.net traffic from
// tests), unique app credentials, and a bare F-Chat client speaking straight
// to fchat-sim for the "other side" of relays.

import type { Page } from "@playwright/test";

const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

export async function interceptAvatars(page: Page): Promise<void> {
  await page.route("https://static.f-list.net/**", (route) =>
    route.fulfill({ contentType: "image/png", body: TINY_PNG }),
  );
}

export function credentials() {
  const unique = `${String(Date.now())}${String(Math.floor(Math.random() * 1000))}`;
  return {
    username: `e2e${unique}`,
    email: `e2e-${unique}@example.test`,
    password: "correct-horse-battery",
  };
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A bare F-Chat client speaking straight to fchat-sim. */
export class SimClient {
  #ws!: WebSocket;
  readonly #listeners = new Set<(cmd: string, payload: unknown) => void>();

  static async connect(
    account: string,
    password: string,
    character: string,
  ): Promise<SimClient> {
    const response = await fetch(process.env["FCHAT_SIM_TICKET_URL"]!, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ account, password }).toString(),
    });
    const { ticket } = (await response.json()) as { ticket: string };
    const client = new SimClient();
    await client.#open(account, ticket, character);
    return client;
  }

  #open(account: string, ticket: string, character: string): Promise<void> {
    this.#ws = new WebSocket(process.env["FCHAT_SIM_WS_URL"]!);
    return new Promise((resolve, reject) => {
      this.#ws.addEventListener("open", () => {
        this.send("IDN", {
          method: "ticket",
          account,
          ticket,
          character,
          cname: "emberchat-e2e",
          cversion: "0.0.0",
        });
      });
      this.#ws.addEventListener("message", (event) => {
        const raw = String(event.data);
        const cmd = raw.slice(0, 3);
        const payload: unknown = raw.length > 4 ? JSON.parse(raw.slice(4)) : {};
        if (cmd === "PIN") {
          this.#ws.send("PIN"); // solicited reply — PIN discipline
        }
        if (cmd === "IDN") {
          resolve();
        }
        for (const listener of [...this.#listeners]) {
          listener(cmd, payload);
        }
      });
      this.#ws.addEventListener("error", () => {
        reject(new Error("sim socket error"));
      });
    });
  }

  send(cmd: string, payload?: unknown): void {
    this.#ws.send(
      payload === undefined ? cmd : `${cmd} ${JSON.stringify(payload)}`,
    );
  }

  waitFor(
    cmd: string,
    predicate: (payload: never) => boolean,
    timeoutMs = 10_000,
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#listeners.delete(listener);
        reject(new Error(`timed out waiting for ${cmd}`));
      }, timeoutMs);
      const listener = (got: string, payload: unknown) => {
        if (got === cmd && predicate(payload as never)) {
          clearTimeout(timer);
          this.#listeners.delete(listener);
          resolve(payload);
        }
      };
      this.#listeners.add(listener);
    });
  }

  close(): void {
    this.#ws.close();
  }
}
