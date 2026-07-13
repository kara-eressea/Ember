// The M1 step-10 gate: the full slice against the real server + fchat-sim.
// One browser drives the app as Cindral; a raw sim client plays Birch Rowan
// on the other side of the relay (auth.spec owns Amber Vale — a character
// may only hold one sim connection, so the specs never share one).

import { expect, test, type Page } from "@playwright/test";

const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

async function interceptAvatars(page: Page): Promise<void> {
  await page.route("https://static.f-list.net/**", (route) =>
    route.fulfill({ contentType: "image/png", body: TINY_PNG }),
  );
}

function credentials() {
  const unique = `${String(Date.now())}${String(Math.floor(Math.random() * 1000))}`;
  return {
    username: `e2e${unique}`,
    email: `e2e-${unique}@example.test`,
    password: "correct-horse-battery",
  };
}

/** How many channel messages Birch pumps in to force history pagination
 * (the initial REST page is 50). */
const SEED_COUNT = 70;
/** Above the sim's msg_flood window (50ms in the E2E world). */
const SEED_SPACING_MS = 80;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A bare F-Chat client speaking straight to fchat-sim. */
class SimClient {
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

test("full slice: connect, join, chat both ways, PMs, live members, history scroll", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await interceptAvatars(page);
  const creds = credentials();

  // ── Register → identity → connect ─────────────────────────────────────
  await page.goto("/register");
  await page.getByLabel("Username").fill(creds.username);
  await page.getByLabel("Email").fill(creds.email);
  await page.getByLabel("Password").fill(creds.password);
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Create account" }).click();
  await page.getByRole("button", { name: "Add a server identity" }).click();
  await page.getByLabel("F-List account name").fill("amber@example.test");
  await page.getByLabel("F-List password").fill("hunter2");
  await page.getByRole("button", { name: "Verify account" }).click();
  await page.getByRole("listitem").filter({ hasText: "Cindral" }).click();
  await page.getByRole("button", { name: "Connect" }).click();

  // The shell comes up and the server-held session reaches the sim.
  await expect(page).toHaveURL(/\/app\//);
  await expect(page.getByText("Cindral · online")).toBeVisible({
    timeout: 15_000,
  });

  // ── Join a channel ────────────────────────────────────────────────────
  await page.getByLabel("Join a channel").fill("Frontpage");
  await page.getByRole("button", { name: "Join", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Frontpage" })).toBeVisible({
    timeout: 10_000,
  });
  await expect(page.getByText("The sim's default hangout")).toBeVisible();

  // Member list: the three seeded NPCs plus us, grouped with role glyphs.
  const members = page.getByRole("complementary", { name: "Members" });
  await expect(members.getByRole("listitem")).toHaveCount(4);
  await expect(members.getByText("Nyx Firemane")).toBeVisible();
  await expect(members.getByText("Old Greywhisker")).toBeVisible();
  await expect(members.getByText("Cindral")).toBeVisible();

  // ── Send a channel message (persisted, echoed back via the gateway) ───
  const log = page.getByTestId("message-log");
  const composer = page.getByRole("textbox", { name: "Message", exact: true });
  await composer.fill("Hello from the ember side");
  await composer.press("Enter");
  await expect(log.getByText("Hello from the ember side")).toBeVisible();
  await expect(composer).toHaveValue("");

  // ── The other side: Birch Rowan joins live ────────────────────────────
  const birch = await SimClient.connect(
    "birch@example.test",
    "hunter2",
    "Birch Rowan",
  );
  try {
    birch.send("JCH", { channel: "Frontpage" });
    // Live member-list update, no refresh.
    await expect(members.getByRole("listitem")).toHaveCount(5);
    await expect(members.getByText("Birch Rowan")).toBeVisible();

    // Receive a channel message.
    birch.send("MSG", { channel: "Frontpage", message: "Evening, all." });
    await expect(log.getByText("Evening, all.")).toBeVisible();

    // ── PMs, both directions ────────────────────────────────────────────
    birch.send("PRI", {
      recipient: "Cindral",
      message: "A word in private?",
    });
    const nav = page.getByRole("navigation");
    const dmRow = nav.getByRole("link", { name: /Birch Rowan/ });
    await expect(dmRow).toBeVisible();
    await expect(dmRow).toContainText("1"); // unread badge
    await dmRow.click();
    await expect(log.getByText("A word in private?")).toBeVisible();

    const received = birch.waitFor(
      "PRI",
      (payload: { character: string; message: string }) =>
        payload.character === "Cindral" && payload.message === "On my way.",
    );
    await composer.fill("On my way.");
    await composer.press("Enter");
    await received;

    // ── Seed history past one REST page, then prove scroll-up loads it ──
    await nav.getByRole("link", { name: /Frontpage/ }).click();
    await expect(
      page.getByRole("heading", { name: "Frontpage" }),
    ).toBeVisible();
    for (let i = 1; i <= SEED_COUNT; i += 1) {
      birch.send("MSG", {
        channel: "Frontpage",
        message: `seed #${String(i)}`,
      });
      await delay(SEED_SPACING_MS);
    }
    await expect(
      log.getByText(`seed #${String(SEED_COUNT)}`, { exact: true }),
    ).toBeVisible({ timeout: 15_000 });

    // Reload: the server-held session stayed online (the bouncer property);
    // the deep link routes straight back into Frontpage and the log
    // backfills its latest page over REST.
    await page.reload();
    await expect(
      log.getByText(`seed #${String(SEED_COUNT)}`, { exact: true }),
    ).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("Cindral · online")).toBeVisible();

    // Scroll to the top repeatedly; each pass pages older history in until
    // the very first message of the conversation is on screen.
    await expect(async () => {
      await log.evaluate((el) => {
        el.scrollTop = 0;
      });
      await expect(log.getByText("Hello from the ember side")).toBeVisible({
        timeout: 1_000,
      });
    }).toPass({ timeout: 20_000 });
  } finally {
    birch.close();
  }
});
