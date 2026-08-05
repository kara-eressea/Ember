/**
 * The app account: the login row the desktop shell provisions for itself on
 * first run, so the user never meets the web app's login screen
 * (mx3-desktop-shell.md §3).
 *
 * It is not an identity. The F-List characters are the identities; this is the
 * local bouncer's own front door, on a machine with exactly one user, and its
 * password is machine-generated and never shown to anybody.
 */

/** Username for the app account — `usernameField` allows this as-is. */
export const APP_ACCOUNT_USERNAME = "desktop";

/**
 * The account's email domain. The server requires a syntactically valid email
 * (`emailField` = `z.email()`) and there is nowhere to send mail, so this is a
 * placeholder in the reserved `.localhost` namespace, which by definition
 * never resolves off this machine. The product half is derived from the app's
 * configured name (Electron's `app.getName()` — `productName` in
 * package.json), because the product name is config, not a literal to scatter
 * (CLAUDE.md).
 */
const EMAIL_DOMAIN_SUFFIX = ".localhost";

/** If the configured name slugs down to nothing, this stands in. */
const FALLBACK_SLUG = "desktop-app";

export interface AppAccount {
  readonly email: string;
  readonly username: string;
}

/** `EmberChat` → `emberchat`; anything unusable → the fallback. */
export function productSlug(productName: string): string {
  const slug = productName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug === "" ? FALLBACK_SLUG : slug;
}

/** The provisioned account's identity, derived from the configured app name. */
export function appAccount(productName: string): AppAccount {
  return {
    email: `${APP_ACCOUNT_USERNAME}@${productSlug(productName)}${EMAIL_DOMAIN_SUFFIX}`,
    username: APP_ACCOUNT_USERNAME,
  };
}

/**
 * Argv for the runtime's admin CLI. The password is never here — it goes down
 * the child's stdin, because argv is readable by every process on the host
 * (the CLI's own header says so).
 */
export function createUserArgs(account: AppAccount): string[] {
  return [
    "create-user",
    "--email",
    account.email,
    "--username",
    account.username,
    "--password-stdin",
  ];
}

/** Argv for re-pointing an existing app account at a freshly generated password. */
export function resetPasswordArgs(account: AppAccount): string[] {
  return ["reset-password", "--email", account.email, "--password-stdin"];
}

/**
 * What this login shows up as in the session list. `deviceLabel` is capped at
 * 100 characters server-side, and a hostname can be long, so it is trimmed
 * rather than left to be rejected.
 */
export function deviceLabel(hostname: string): string {
  const host = hostname.replace(/\.local$/, "").trim();
  const label = host === "" ? "Desktop app" : `Desktop app on ${host}`;
  return label.slice(0, 100);
}
