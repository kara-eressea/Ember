// Guard test for the invariant behind the `as ServerCommand` /
// `as ClientCommand` casts in the two parsers: every schema in the tables is
// either ALWAYS bare (its only accepted input is undefined — PIN, CHA, ORS)
// or NEVER bare. A schema that accepts both — `z.object({…}).optional()`,
// `z.unknown()`, `z.undefined().or(…)` — would make the mapped command type
// claim `{ cmd }` while a parse still yields a payload, and the cast would
// hand callers a lie. Walking the tables here makes such an addition fail by
// name instead of at some distant call site.

import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { clientCommandSchemas, parseClientCommand } from "./client-commands.js";
import { parseServerCommand, serverCommandSchemas } from "./server-commands.js";

/** Stand-ins for "a payload arrived": a bare schema must accept none of
 * these, or it is only sometimes bare. */
const PAYLOAD_PROBES: readonly unknown[] = [
  {},
  { channel: "Frontpage" },
  { number: 6, message: "The character requested was not found." },
  "",
  "payload",
  0,
  1,
  true,
  null,
  [],
  ["Hexxy"],
];

/** True if the schema is bare — and, if so, bare and nothing else. */
function assertNotSometimesBare(command: string, schema: z.ZodType): boolean {
  const bare = schema.safeParse(undefined);
  if (!bare.success) {
    return false;
  }
  expect(
    bare.data,
    `${command} parses undefined into a payload`,
  ).toBeUndefined();
  // The decisive check: a bare command's schema must be `z.undefined()`
  // itself. Anything that merely tolerates undefined — an `.optional()`
  // wrapper, `z.any()`, a union — accepts payloads too, and no fixed set of
  // probes can prove otherwise for an arbitrary future schema.
  expect(
    schema.def.type,
    `${command} accepts undefined but is not z.undefined() — every schema must be always-bare or never-bare`,
  ).toBe("undefined");
  for (const probe of PAYLOAD_PROBES) {
    expect(
      schema.safeParse(probe).success,
      `${command} is bare but also accepts ${JSON.stringify(probe)} — every schema must be always-bare or never-bare`,
    ).toBe(false);
  }
  return true;
}

/** The cast site itself: the bare wire form (the name alone) parses to a
 * typed command with no payload property exactly for the bare schemas. */
function assertBareFrameAgrees(
  command: string,
  bare: boolean,
  parsed: { readonly cmd: string },
): void {
  expect(
    !("raw" in parsed),
    `${command} disagrees with its schema on whether the bare wire form parses`,
  ).toBe(bare);
  expect("payload" in parsed, `${command} bare frame carries a payload`).toBe(
    false,
  );
}

describe("bare-command invariant", () => {
  it.each(Object.keys(serverCommandSchemas))(
    "server %s is always bare or never bare",
    (command) => {
      const name = command as keyof typeof serverCommandSchemas;
      const bare = assertNotSometimesBare(name, serverCommandSchemas[name]);
      assertBareFrameAgrees(name, bare, parseServerCommand(name));
    },
  );

  it.each(Object.keys(clientCommandSchemas))(
    "client %s is always bare or never bare",
    (command) => {
      const name = command as keyof typeof clientCommandSchemas;
      const bare = assertNotSometimesBare(name, clientCommandSchemas[name]);
      assertBareFrameAgrees(name, bare, parseClientCommand(name));
    },
  );

  it("fails a schema that is only sometimes bare", () => {
    // The regression the walk exists to catch, proven against a stand-in.
    expect(() =>
      assertNotSometimesBare("CDS", serverCommandSchemas.CDS.optional()),
    ).toThrow(/always-bare or never-bare/);
  });
});
