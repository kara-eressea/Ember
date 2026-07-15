// The M1 step-9 gate: register → login → see the character list with
// avatars. Runs against the real server + fchat-sim (see global-setup.ts);
// avatar images are intercepted so static.f-list.net isn't hit from CI.
// Owns aspen@example.test — sharing an ACCOUNT between parallel specs makes
// their ticket managers invalidate each other (every new ticket kills all
// previous ones account-wide), so accounts are spec-exclusive like
// characters and channels.

import { expect, test, type Page } from "@playwright/test";

// 1×1 transparent PNG — stands in for every F-List avatar.
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

test("register, connect an F-List account, and pick a character with avatars", async ({
  page,
}) => {
  await interceptAvatars(page);
  const creds = credentials();

  // Landing → create account.
  await page.goto("/");
  await page
    .getByRole("navigation")
    .getByRole("link", { name: "Create account" })
    .click();
  await page.getByLabel("Username").fill(creds.username);
  await page.getByLabel("Email").fill(creds.email);
  await page.getByLabel("Password").fill(creds.password);
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Create account" }).click();

  // Straight into the identity picker.
  await expect(page).toHaveURL(/\/identities$/);
  await expect(page.getByText(`${creds.email} · app account`)).toBeVisible();

  // Add the F-List account (verified against the sim, vaulted in memory).
  await page.getByRole("button", { name: "Add a server identity" }).click();
  await page.getByLabel("F-List account name").fill("aspen@example.test");
  await page.getByLabel("F-List password").fill("hunter2");
  await page.getByRole("button", { name: "Verify account" }).click();

  // The character list — with avatar images — is the step gate. The server
  // honors the real ≤1 req/s F-List ticket budget, and spec files run in
  // parallel on multi-core machines, so this fetch can queue behind the
  // other specs' registrations — give it the same window as session-online
  // waits, not the 5s expect default.
  const aspen = page.getByRole("listitem").filter({ hasText: "Aspen Vale" });
  const cindral = page.getByRole("listitem").filter({ hasText: "Aspen Brook" });
  await expect(aspen).toBeVisible({ timeout: 15_000 });
  await expect(cindral).toBeVisible();
  await expect(aspen.locator("img")).toHaveAttribute(
    "src",
    "https://static.f-list.net/images/avatar/aspen vale.png",
  );

  // Picking a character creates the identity.
  await aspen.click();
  const identityRow = page.getByText("Aspen Vale", { exact: true });
  await expect(identityRow).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Connect" }),
    // Identity creation validates the character via the throttled (1 req/s)
    // F-List API — parallel spec files queue behind each other here.
  ).toBeVisible({ timeout: 15_000 });

  // Connect leads into the app route (shell arrives in step 10).
  await page.getByRole("button", { name: "Connect" }).click();
  await expect(page).toHaveURL(/\/app\//);

  // Log the character off again (MeBar power control) — sessions outlive
  // tabs, and a later test in this file connects Aspen Vale itself; a
  // character can hold only one sim connection.
  await expect(page.getByText("Aspen Vale · online")).toBeVisible({
    timeout: 15_000,
  });
  await page.getByRole("button", { name: "Log off F-Chat" }).click();
  await expect(
    page.getByText(/stopped — disconnected by user/).first(),
  ).toBeVisible();
});

test("login round trip sees the persisted identity again", async ({ page }) => {
  await interceptAvatars(page);
  const creds = credentials();

  // Register + create an identity through the UI.
  await page.goto("/register");
  await page.getByLabel("Username").fill(creds.username);
  await page.getByLabel("Email").fill(creds.email);
  await page.getByLabel("Password").fill(creds.password);
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Create account" }).click();
  await page.getByRole("button", { name: "Add a server identity" }).click();
  await page.getByLabel("F-List account name").fill("aspen@example.test");
  await page.getByLabel("F-List password").fill("hunter2");
  await page.getByRole("button", { name: "Verify account" }).click();
  await page.getByRole("listitem").filter({ hasText: "Aspen Brook" }).click();
  await expect(page.getByRole("button", { name: "Connect" })).toBeVisible({
    timeout: 15_000,
  });

  // Sign out, log back in: the identity persisted server-side.
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/login$/);
  await page.getByLabel("Email").fill(creds.email);
  await page.getByLabel("Password").fill(creds.password);
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page).toHaveURL(/\/identities$/);
  await expect(page.getByText("Aspen Brook", { exact: true })).toBeVisible();
});

test("a persisted session survives a reload", async ({ page }) => {
  const creds = credentials();
  await page.goto("/register");
  await page.getByLabel("Username").fill(creds.username);
  await page.getByLabel("Email").fill(creds.email);
  await page.getByLabel("Password").fill(creds.password);
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/identities$/);

  // Reload: restore() revalidates the persisted refresh token (rotating it)
  // and the picker renders without a login round trip.
  await page.reload();
  await expect(page.getByText(`${creds.email} · app account`)).toBeVisible();

  // And again — proving the rotated token was persisted correctly.
  await page.reload();
  await expect(page.getByText(`${creds.email} · app account`)).toBeVisible();
});

test("identities can be connected, disconnected and removed from the picker", async ({
  page,
}) => {
  await interceptAvatars(page);
  const creds = credentials();
  await page.goto("/register");
  await page.getByLabel("Username").fill(creds.username);
  await page.getByLabel("Email").fill(creds.email);
  await page.getByLabel("Password").fill(creds.password);
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Create account" }).click();
  await page.getByRole("button", { name: "Add a server identity" }).click();
  await page.getByLabel("F-List account name").fill("aspen@example.test");
  await page.getByLabel("F-List password").fill("hunter2");
  await page.getByRole("button", { name: "Verify account" }).click();
  await page.getByRole("listitem").filter({ hasText: "Aspen Vale" }).click();
  await expect(page.getByRole("button", { name: "Connect" })).toBeVisible({
    timeout: 15_000,
  });

  // Connect from the picker; the shell reports the session online.
  await page.getByRole("button", { name: "Connect" }).click();
  await expect(page).toHaveURL(/\/app\//);
  await expect(page.getByText("Aspen Vale · online")).toBeVisible({
    timeout: 15_000,
  });

  // Back on the picker the live session is visible and can be logged off —
  // the session outlives tabs (bouncer), so this is the deliberate way out.
  await page.goto("/identities");
  await expect(page.getByText(/aspen@example\.test · online/)).toBeVisible();
  await page.getByRole("button", { name: "Disconnect" }).click();
  await expect(page.getByText(/aspen@example\.test · offline/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Connect" })).toBeVisible({
    timeout: 15_000,
  });

  // Remove the identity: two-step confirm.
  await page
    .getByRole("button", { name: "Remove identity Aspen Vale and its history" })
    .click();
  await page
    .getByRole("button", { name: /Confirm removing identity Aspen Vale/ })
    .click();
  await expect(page.getByRole("button", { name: "Connect" })).toHaveCount(0);

  // The add flow fast-paths into the character grid, but Manage accounts
  // reaches the chooser, where the account itself can be removed.
  await page.getByRole("button", { name: "Add a server identity" }).click();
  await expect(
    page.getByRole("listitem").filter({ hasText: "Aspen Vale" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Manage accounts" }).click();
  await expect(
    page
      .getByText("locked", { exact: false })
      .or(page.getByText("unlocked", { exact: true })),
  ).toBeVisible();
  await page
    .getByRole("button", { name: /Remove account aspen@example.test/ })
    .click();
  await page
    .getByRole("button", {
      name: /Confirm removing account aspen@example.test/,
    })
    .click();

  // Back to a blank, editable add form — no dead end.
  const accountField = page.getByLabel("F-List account name");
  await expect(accountField).toBeVisible();
  await expect(accountField).toBeEnabled();
  await expect(accountField).toHaveValue("");
});

test("login with a wrong password is rejected", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill("nobody@example.test");
  await page.getByLabel("Password").fill("wrong-password");
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page.getByRole("alert")).toContainText(
    "Invalid email or password",
  );
});
