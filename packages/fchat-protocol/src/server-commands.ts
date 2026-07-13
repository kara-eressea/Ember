// Schemas for commands sent by the F-Chat server (design/server-commands.md).
//
// Parsing is lenient by design: an unknown command, or a known command whose
// payload does not match its schema, is returned as a RawCommand — parsing
// never throws (developer policy: never crash on unknown commands). Fields
// with a documented value set (gender, status, mode) are typed as plain
// strings here; see src/enums.ts.

import { z } from "zod";
import { parseFrame, serializeFrame, type RawCommand } from "./codec.js";

export const serverCommandSchemas = {
  /** Channel description changed. Sent after every JCH. */
  CDS: z.object({ channel: z.string(), description: z.string() }),
  /** List of all public channels. */
  CHA: z.object({
    channels: z.array(
      z.object({ name: z.string(), mode: z.string(), characters: z.int() }),
    ),
  }),
  /** List of channel ops. First entry is the owner (may be ""). */
  COL: z.object({ channel: z.string(), oplist: z.array(z.string()) }),
  /** Connected-user count, sent after identification and before the LIS batches. */
  CON: z.object({ count: z.int() }),
  /** An error occurred. See src/error-codes.ts. */
  ERR: z.object({ number: z.int(), message: z.string() }),
  /** A character went offline. Treat as a global LCH for that character. */
  FLN: z.object({ character: z.string() }),
  /** Server hello, sent after successful identification. */
  HLO: z.object({ message: z.string() }),
  /** Initial channel data, in response to JCH (along with CDS). */
  ICH: z.object({
    users: z.array(z.object({ identity: z.string() })),
    channel: z.string(),
    mode: z.string(),
  }),
  /** Identification succeeded. */
  IDN: z.object({ character: z.string() }),
  /** A character joined a channel (possibly our own). */
  JCH: z.object({
    channel: z.string(),
    character: z.object({ identity: z.string() }),
    title: z.string(),
  }),
  /** Ignore-list state: `init` carries the full list at login, `add` and
   * `delete` acknowledge client changes. Lenient on purpose — actions we do
   * not know keep the command parseable. */
  IGN: z.object({
    action: z.string(),
    character: z.string().optional(),
    characters: z.array(z.string()).optional(),
  }),
  /** A character left a channel (possibly our own). */
  LCH: z.object({ channel: z.string(), character: z.string() }),
  /** Online characters: [name, gender, status, status message]. Sent in batches. */
  LIS: z.object({
    characters: z.array(
      z.tuple([z.string(), z.string(), z.string(), z.string()]),
    ),
  }),
  /** A channel message. */
  MSG: z.object({
    character: z.string(),
    message: z.string(),
    channel: z.string(),
  }),
  /** A character connected. */
  NLN: z.object({
    identity: z.string(),
    gender: z.string(),
    status: z.string(),
  }),
  /** List of open private rooms. */
  ORS: z.object({
    channels: z.array(
      z.object({ name: z.string(), characters: z.int(), title: z.string() }),
    ),
  }),
  /** Keepalive ping; must be answered with a client PIN. Bare command. */
  PIN: z.undefined(),
  /** A private message. */
  PRI: z.object({ character: z.string(), message: z.string() }),
  /** A character changed status. */
  STA: z.object({
    status: z.string(),
    character: z.string(),
    statusmsg: z.string().default(""),
  }),
  /** Informative server message; also the response to several commands. */
  SYS: z.object({ message: z.string(), channel: z.string().optional() }),
  /** Typing status for private messages. */
  TPN: z.object({ character: z.string(), status: z.string() }),
  /** A server variable (flood/length limits etc.). See src/vars.ts. */
  VAR: z.object({
    variable: z.string(),
    value: z.union([z.number(), z.string(), z.array(z.string())]),
  }),
} as const;

export type ServerCommandName = keyof typeof serverCommandSchemas;

export type ServerCommandPayload<K extends ServerCommandName> = z.infer<
  (typeof serverCommandSchemas)[K]
>;

export type ServerCommand = {
  [K in ServerCommandName]: undefined extends ServerCommandPayload<K>
    ? { readonly cmd: K }
    : { readonly cmd: K; readonly payload: ServerCommandPayload<K> };
}[ServerCommandName];

export function isServerCommandName(cmd: string): cmd is ServerCommandName {
  return Object.hasOwn(serverCommandSchemas, cmd);
}

/**
 * Parses a raw wire string from the server. Never throws: malformed frames,
 * unknown commands, and known commands with unexpected payloads all come
 * back as a RawCommand for the caller to log and swallow.
 */
export function parseServerCommand(raw: string): ServerCommand | RawCommand {
  const result = parseFrame(raw);
  if (!result.ok) {
    return { cmd: raw.slice(0, 3), raw };
  }
  const { cmd, payload } = result.frame;
  if (!isServerCommandName(cmd)) {
    return { cmd, raw };
  }
  const parsed = serverCommandSchemas[cmd].safeParse(payload);
  if (!parsed.success) {
    return { cmd, raw };
  }
  return (
    parsed.data === undefined ? { cmd } : { cmd, payload: parsed.data }
  ) as ServerCommand;
}

export function isKnownServerCommand(
  command: ServerCommand | RawCommand,
): command is ServerCommand {
  return !("raw" in command);
}

export function serializeServerCommand(command: ServerCommand): string {
  return serializeFrame(command);
}
