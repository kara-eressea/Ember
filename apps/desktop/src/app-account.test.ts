import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  appAccount,
  APP_ACCOUNT_USERNAME,
  createUserArgs,
  deviceLabel,
  productSlug,
  resetPasswordArgs,
} from "./app-account.js";
import { adminCliInvocation, isAccountTakenFailure } from "./admin-cli.js";

// The server's own field rules (apps/server/src/modules/auth/account-fields.ts
// — and `loginBody` in the auth routes uses the same email validator). Copied
// rather than imported: this package deliberately does not depend on the
// server's source tree, only on its built runtime.
const emailField = z.email().max(254);
const usernameField = z
  .string()
  .min(3)
  .max(32)
  .regex(/^[a-zA-Z0-9_.-]+$/);

describe("the app account", () => {
  it("is acceptable to the server's own validators", () => {
    const account = appAccount("EmberChat");
    expect(emailField.safeParse(account.email).success).toBe(true);
    expect(usernameField.safeParse(account.username).success).toBe(true);
  });

  it("derives the email from the configured product name", () => {
    expect(appAccount("EmberChat").email).toBe("desktop@emberchat.localhost");
    expect(appAccount("Some Other Name").email).toBe(
      "desktop@some-other-name.localhost",
    );
  });

  it.each([
    ["EmberChat", "emberchat"],
    ["Ember Chat!", "ember-chat"],
    ["  ", "desktop-app"],
    ["日本語", "desktop-app"],
  ])("slugs %o to %o", (name, slug) => {
    expect(productSlug(name)).toBe(slug);
  });

  it("still validates for an exotic product name", () => {
    const account = appAccount("★ Ember ★");
    expect(emailField.safeParse(account.email).success).toBe(true);
  });
});

describe("admin CLI invocation", () => {
  const account = appAccount("EmberChat");
  const env = { DB_DRIVER: "pglite", PGLITE_DATA_DIR: "/data/db" };

  it("passes the account on argv and the password nowhere near it", () => {
    const invocation = adminCliInvocation({
      execPath: "/Applications/Electron.app/electron",
      cliEntry: "/runtime/dist/cli/admin.js",
      args: createUserArgs(account),
      env,
    });
    expect(invocation.command).toBe("/Applications/Electron.app/electron");
    expect(invocation.args).toEqual([
      "/runtime/dist/cli/admin.js",
      "create-user",
      "--email",
      "desktop@emberchat.localhost",
      "--username",
      APP_ACCOUNT_USERNAME,
      "--password-stdin",
    ]);
    // argv is world-readable; the password goes down stdin instead.
    expect(invocation.args).not.toContain("--password");
  });

  it("runs Electron's binary as Node, with the server's own env", () => {
    const invocation = adminCliInvocation({
      execPath: "/electron",
      cliEntry: "/runtime/dist/cli/admin.js",
      args: createUserArgs(account),
      env,
    });
    expect(invocation.env).toEqual({
      ...env,
      ELECTRON_RUN_AS_NODE: "1",
    });
  });

  it("has a reset-password form for adopting an existing account", () => {
    expect(resetPasswordArgs(account)).toEqual([
      "reset-password",
      "--email",
      "desktop@emberchat.localhost",
      "--password-stdin",
    ]);
  });

  it("recognizes the CLI's already-taken refusal, and only that", () => {
    // The literal comes from apps/server/src/cli/admin.ts.
    expect(isAccountTakenFailure("Email or username is already taken\n")).toBe(
      true,
    );
    expect(isAccountTakenFailure("DATABASE_URL is not set\n")).toBe(false);
  });
});

describe("deviceLabel", () => {
  it("names the machine and stays inside the server's 100-char cap", () => {
    expect(deviceLabel("kara-mbp.local")).toBe("Desktop app on kara-mbp");
    expect(deviceLabel("x".repeat(200))).toHaveLength(100);
  });

  it("degrades to a bare label when there is no hostname", () => {
    expect(deviceLabel("")).toBe("Desktop app");
  });
});
