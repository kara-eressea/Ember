// EmberChat admin CLI — how accounts are born on an admin-only instance
// (decisions.md §2: registration is disabled by default; there is no email,
// so password resets happen here too). Talks to Postgres directly via
// DATABASE_URL; the server does not need to be running, but the database
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
import { createDb } from "../db/index.js";
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

DATABASE_URL must be set in the environment.`;

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

const databaseUrl = process.env["DATABASE_URL"];
if (!databaseUrl) {
  fail("DATABASE_URL is not set");
}

const { values } = parseArgs({
  args: rest,
  options: {
    email: { type: "string" },
    username: { type: "string" },
    password: { type: "string" },
    "password-stdin": { type: "boolean" },
  },
});

const { db, pool } = createDb(databaseUrl);

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
  await pool.end();
}
