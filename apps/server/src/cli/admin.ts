// EmberChat admin CLI — how accounts are born on an admin-only instance
// (decisions.md §2: registration is disabled by default; there is no email,
// so password resets happen here too). Talks to the database directly via
// DATABASE_URL — or, on a desktop-style install, DB_DRIVER=pglite plus
// PGLITE_DATA_DIR; the server does not need to be running, but the database
// must be migrated (the server migrates on boot).
//
//   node dist/cli/admin.js create-user --email a@example.com --username kara --password-stdin
//   node dist/cli/admin.js reset-password --email a@example.com --password-stdin
//
// --password <value> is accepted for scripting against throwaway databases
// (tests, dev stacks); prefer --password-stdin interactively — argv is
// visible to every process on the host.

import { parseArgs } from "node:util";
import argon2 from "argon2";
import { eq } from "drizzle-orm";
import type { ZodType } from "zod";
import { createDb, type DbDriver } from "../db/index.js";
import { isUniqueViolation } from "../db/errors.js";
import { appUsers } from "../db/schema.js";
import {
  emailField,
  passwordField,
  usernameField,
} from "../modules/auth/account-fields.js";

const USAGE = `Usage:
  admin.js create-user   --email <email> --username <name> (--password <pw> | --password-stdin)
  admin.js reset-password --email <email>                  (--password <pw> | --password-stdin)

DATABASE_URL must be set in the environment (or DB_DRIVER=pglite with PGLITE_DATA_DIR).`;

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks)
    .toString("utf8")
    .replace(/\r?\n$/, "");
}

async function resolvePassword(values: {
  password?: string;
  "password-stdin"?: boolean;
}): Promise<string> {
  if (values.password !== undefined && values["password-stdin"]) {
    fail("Pass either --password or --password-stdin, not both");
  }
  const raw = values["password-stdin"] ? await readStdin() : values.password;
  if (raw === undefined || raw === "") {
    fail("A password is required: --password <pw> or --password-stdin");
  }
  const parsed = passwordField.safeParse(raw);
  if (!parsed.success) {
    fail(`Invalid password: ${parsed.error.issues[0]?.message ?? "invalid"}`);
  }
  return parsed.data;
}

function parseField<T>(
  field: ZodType<T>,
  value: string | undefined,
  label: string,
): T {
  if (value === undefined) {
    fail(`--${label} is required`);
  }
  const parsed = field.safeParse(value);
  if (!parsed.success) {
    fail(`Invalid ${label}: ${parsed.error.issues[0]?.message ?? "invalid"}`);
  }
  return parsed.data;
}

const [command, ...rest] = process.argv.slice(2);
if (!command || command === "--help" || command === "help") {
  console.log(USAGE);
  process.exit(command ? 0 : 1);
}

// The CLI reads the environment itself rather than through loadConfig — it
// has no use for AUTH_SECRET and friends, and demanding them here would make
// creating the first account harder than it is.
const driver: DbDriver = ((): DbDriver => {
  if (process.env["DB_DRIVER"] === "pglite") {
    const dataDir = process.env["PGLITE_DATA_DIR"];
    if (!dataDir) {
      fail("PGLITE_DATA_DIR is not set (DB_DRIVER=pglite)");
    }
    return { kind: "pglite", dataDir };
  }
  const connectionString = process.env["DATABASE_URL"];
  if (!connectionString) {
    fail("DATABASE_URL is not set");
  }
  return { kind: "node-postgres", connectionString };
})();

const { values } = parseArgs({
  args: rest,
  options: {
    email: { type: "string" },
    username: { type: "string" },
    password: { type: "string" },
    "password-stdin": { type: "boolean" },
  },
});

const { db, close } = await createDb(driver);

try {
  switch (command) {
    case "create-user": {
      const email = parseField(emailField, values.email, "email");
      const username = parseField(usernameField, values.username, "username");
      const passwordHash = await argon2.hash(await resolvePassword(values));
      try {
        const [user] = await db
          .insert(appUsers)
          .values({ email: email.toLowerCase(), username, passwordHash })
          .returning({ id: appUsers.id, username: appUsers.username });
        console.log(
          `Created user ${user?.username ?? username} (${user?.id ?? "?"})`,
        );
      } catch (error) {
        if (isUniqueViolation(error)) {
          fail("Email or username is already taken");
        }
        throw error;
      }
      break;
    }
    case "reset-password": {
      const email = parseField(emailField, values.email, "email");
      const passwordHash = await argon2.hash(await resolvePassword(values));
      const [user] = await db
        .update(appUsers)
        .set({ passwordHash })
        .where(eq(appUsers.email, email.toLowerCase()))
        .returning({ username: appUsers.username });
      if (!user) {
        fail(`No user with email ${email}`);
      }
      console.log(`Password reset for ${user.username}`);
      break;
    }
    default:
      fail(`Unknown command "${command}"\n\n${USAGE}`);
  }
} finally {
  await close();
}
