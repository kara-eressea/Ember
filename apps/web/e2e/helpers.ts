// Shared E2E plumbing: avatar interception (no real f-list.net traffic from
// tests), unique app credentials, and a bare F-Chat client speaking straight
// to fchat-sim for the "other side" of relays.

import { execFile } from "node:child_process";
import { deflateSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, type Page } from "@playwright/test";

const execFileAsync = promisify(execFile);

// The E2E stack runs the production shape: registration is disabled
// (decisions.md §2), so accounts are born through the admin CLI, exactly
// like on a real instance.
const ADMIN_CLI = fileURLToPath(
  new URL("../../server/dist/cli/admin.js", import.meta.url),
);

const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

export async function interceptAvatars(page: Page): Promise<void> {
  // Context-level, not page-level: pages a spec opens later (e.g. the new
  // tab a Ctrl-click on a media link spawns) inherit the route, so no spec
  // path ever reaches the real static.f-list.net.
  await page
    .context()
    .route("https://static.f-list.net/**", (route) =>
      route.fulfill({ contentType: "image/png", body: TINY_PNG }),
    );
}

/** A valid, solid-colour PNG of exact dimensions — the tiny 1×1 avatar stub
 * has no natural size worth measuring, so lightbox-zoom assertions (#236)
 * need a real image whose intrinsic width/height the browser can report. */
export function solidPng(width: number, height: number): Buffer {
  const crc32 = (data: Buffer): number => {
    let crc = ~0;
    for (const byte of data) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) {
        crc = (crc >>> 1) ^ (0xed_b8_83_20 & -(crc & 1));
      }
    }
    return ~crc >>> 0;
  };
  const chunk = (type: string, data: Buffer): Buffer => {
    const typeBuf = Buffer.from(type, "latin1");
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
    return Buffer.concat([len, typeBuf, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour RGB
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const rowStart = y * (stride + 1);
    raw[rowStart] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const p = rowStart + 1 + x * 3;
      raw[p] = 90;
      raw[p + 1] = 110;
      raw[p + 2] = 140;
    }
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
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

/** Creates a fresh app user via the admin CLI against the E2E database. */
export async function provisionUser() {
  const creds = credentials();
  await execFileAsync(
    process.execPath,
    [
      ADMIN_CLI,
      "create-user",
      "--email",
      creds.email,
      "--username",
      creds.username,
      "--password",
      creds.password,
    ],
    { env: { ...process.env, DATABASE_URL: process.env["E2E_DATABASE_URL"] } },
  );
  return creds;
}

/**
 * The standard journey into the shell: provision a fresh app user (admin
 * CLI), log in, add the F-List account, pick the character, connect —
 * resolves once the server-held session is online. Returns the credentials
 * (for logging the same account in elsewhere). auth.spec keeps its own copy
 * on purpose: this flow is its test subject, not its setup.
 */
export async function provisionAndConnect(
  page: Page,
  account: string,
  character: string,
) {
  const creds = await provisionUser();
  await page.goto("/login");
  await page.getByLabel("Email").fill(creds.email);
  await page.getByLabel("Password").fill(creds.password);
  await page.getByRole("button", { name: "Log in" }).click();
  await page.getByRole("button", { name: "Add a server identity" }).click();
  await page.getByLabel("F-List account name").fill(account);
  await page.getByLabel("F-List password").fill("hunter2");
  await page.getByRole("button", { name: "Verify account" }).click();
  await page.getByRole("listitem").filter({ hasText: character }).click();
  await page.getByRole("button", { name: "Connect" }).click();
  await expect(page).toHaveURL(/\/app\//);
  await expect(page.getByText(`${character} · online`)).toBeVisible({
    timeout: 15_000,
  });
  return creds;
}

/**
 * Join a channel by exact key through the channel browser's by-name footer
 * (the inline "Join a channel…" form left the sidebar with the #196
 * toolbar). Resolves once the channel's heading renders.
 */
export async function joinChannel(
  page: Page,
  key: string,
  title = key,
): Promise<void> {
  await page.getByRole("button", { name: "Browse channels" }).click();
  const dialog = page.getByRole("dialog", { name: "Browse channels" });
  await dialog.getByLabel("Join a hidden channel by name").fill(key);
  await dialog.getByRole("button", { name: "Join", exact: true }).click();
  await expect(dialog).not.toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("heading", { name: title })).toBeVisible({
    timeout: 10_000,
  });
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
