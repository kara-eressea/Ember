// The M1 step-9 gate: register → login → see the character list with
// avatars. Runs against the real server + fchat-sim (see global-setup.ts);
// avatar images are intercepted so static.f-list.net isn't hit from CI.

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
  await page.getByLabel("F-List account name").fill("amber@example.test");
  await page.getByLabel("F-List password").fill("hunter2");
  await page.getByRole("button", { name: "Verify account" }).click();

  // The character list — with avatar images — is the step gate.
  const amber = page.getByRole("listitem").filter({ hasText: "Amber Vale" });
  const cindral = page.getByRole("listitem").filter({ hasText: "Cindral" });
  await expect(amber).toBeVisible();
  await expect(cindral).toBeVisible();
  await expect(amber.locator("img")).toHaveAttribute(
    "src",
    "https://static.f-list.net/images/avatar/amber vale.png",
  );

  // Picking a character creates the identity.
  await amber.click();
  const identityRow = page.getByText("Amber Vale", { exact: true });
  await expect(identityRow).toBeVisible();
  await expect(page.getByRole("button", { name: "Connect" })).toBeVisible();

  // Connect leads into the app route (shell arrives in step 10).
  await page.getByRole("button", { name: "Connect" }).click();
  await expect(page).toHaveURL(/\/app\//);
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
  await page.getByLabel("F-List account name").fill("amber@example.test");
  await page.getByLabel("F-List password").fill("hunter2");
  await page.getByRole("button", { name: "Verify account" }).click();
  await page.getByRole("listitem").filter({ hasText: "Cindral" }).click();
  await expect(page.getByRole("button", { name: "Connect" })).toBeVisible();

  // Sign out, log back in: the identity persisted server-side.
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/login$/);
  await page.getByLabel("Email").fill(creds.email);
  await page.getByLabel("Password").fill(creds.password);
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page).toHaveURL(/\/identities$/);
  await expect(page.getByText("Cindral", { exact: true })).toBeVisible();
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
