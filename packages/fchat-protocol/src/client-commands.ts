// Schemas for commands sent by the F-Chat client (design/client-commands.md).
//
// Our own code constructs these as typed ClientCommand values and serializes
// with serializeClientCommand. parseClientCommand exists for the other side
// of the wire — packages/fchat-sim — and is as lenient as the server parser.

import { z } from "zod";
import { parseFrame, serializeFrame, type RawCommand } from "./codec.js";
import {
  CHANNEL_MODES,
  CLIENT_SETTABLE_STATUSES,
  TYPING_STATUSES,
} from "./enums.js";

export const clientCommandSchemas = {
  /** Request the channel banlist (chanop). The response arrives as a SYS. */
  CBL: z.object({ channel: z.string() }),
  /** Ban a character from a channel (chanop). */
  CBU: z.object({ channel: z.string(), character: z.string() }),
  /**
   * Create a private, invite-only channel. The payload is the TITLE — the
   * server assigns the ADH- id and answers with a JCH into the new room.
   */
  CCR: z.object({ channel: z.string() }),
  /** Change a channel's description (chanop). */
  CDS: z.object({ channel: z.string(), description: z.string() }),
  /** Request the list of all public channels. Bare command. */
  CHA: z.undefined(),
  /** Invite a character to a channel (chanop). The response is a SYS. */
  CIU: z.object({ channel: z.string(), character: z.string() }),
  /** Kick a character from a channel (chanop). */
  CKU: z.object({ channel: z.string(), character: z.string() }),
  /** Promote a character to channel operator (chanop). */
  COA: z.object({ channel: z.string(), character: z.string() }),
  /** Demote a channel operator to a normal user (chanop). */
  COR: z.object({ channel: z.string(), character: z.string() }),
  /** Hand the channel to a new owner (current owner only). */
  CSO: z.object({ channel: z.string(), character: z.string() }),
  /** Channel timeout: a temporary ban of 1-90 minutes (chanop). */
  CTU: z.object({
    channel: z.string(),
    character: z.string(),
    length: z.int().min(1).max(90),
  }),
  /** Unban a character from a channel (chanop). The response is a SYS. */
  CUB: z.object({ channel: z.string(), character: z.string() }),
  /**
   * Character search. `kinks` is required (kink ids as strings, per the
   * wiki sample); every other filter is optional. The enum values are
   * server-defined and drift (the wiki sample itself uses a gender spelling
   * missing from its own list), so they stay plain strings here — the
   * server is the validator. Pace: 5s between searches (ERR 50).
   */
  FKS: z.object({
    kinks: z.array(z.string()),
    genders: z.array(z.string()).optional(),
    orientations: z.array(z.string()).optional(),
    languages: z.array(z.string()).optional(),
    furryprefs: z.array(z.string()).optional(),
    roles: z.array(z.string()).optional(),
  }),
  /**
   * Identify with the server. Must be the first command sent; cname/cversion
   * uniquely identify this client (developer policy).
   */
  IDN: z.object({
    method: z.literal("ticket"),
    account: z.string(),
    ticket: z.string(),
    character: z.string(),
    cname: z.string(),
    cversion: z.string(),
  }),
  /**
   * Ignore-list actions. Ignoring is the client's responsibility — the
   * server only stores the list; `notify` tells it an inbound PRI was
   * dropped (it informs the sender), `list` requests the full list.
   */
  IGN: z.discriminatedUnion("action", [
    z.object({ action: z.literal("add"), character: z.string() }),
    z.object({ action: z.literal("delete"), character: z.string() }),
    z.object({ action: z.literal("notify"), character: z.string() }),
    z.object({ action: z.literal("list") }),
  ]),
  /** Join a channel. */
  JCH: z.object({ channel: z.string() }),
  /** Leave a channel. */
  LCH: z.object({ channel: z.string() }),
  /**
   * Send a roleplay ad to a channel. Length limit is lfrp_max; the pace is
   * lfrp_flood (1 per 10 minutes live) — both from VAR at runtime.
   */
  LRP: z.object({ channel: z.string(), message: z.string() }),
  /** Send a channel message. Length/flood limits come from VAR at runtime. */
  MSG: z.object({ channel: z.string(), message: z.string() }),
  /** Request the list of open private rooms. Bare command. */
  ORS: z.undefined(),
  /** Ping response. Bare command; never send more than one per 10 seconds. */
  PIN: z.undefined(),
  /** Send a private message. */
  PRI: z.object({ recipient: z.string(), message: z.string() }),
  /**
   * Roll dice ("#d##", joinable with "+", plus flat numbers) or spin the
   * bottle ("bottle"). The server computes the result and broadcasts an RLL
   * — including back to the roller.
   */
  RLL: z.object({ channel: z.string(), dice: z.string() }),
  /** Set the room mode: chat (MSG only), ads (LRP only), or both. Chanop. */
  RMO: z.object({ channel: z.string(), mode: z.enum(CHANNEL_MODES) }),
  /**
   * Set a private room "public" (listed in ORS, freely joinable) or
   * "private" (unlisted, invite-only). Chanop; official channels have no
   * room status.
   */
  RST: z.object({
    channel: z.string(),
    status: z.enum(["public", "private"]),
  }),
  /**
   * Alert Staff: report a user to F-List's global moderators. Clients always
   * send action "report"; the report string carries channel + reported user
   * + complaint (official-client formatting). Third-party clients cannot
   * upload logs — the text is the whole report.
   */
  SFC: z.object({
    action: z.literal("report"),
    report: z.string(),
    character: z.string(),
  }),
  /** Set own status. "crown" is server-set (RWD) and deliberately excluded. */
  STA: z.object({
    status: z.enum(CLIENT_SETTABLE_STATUSES),
    statusmsg: z.string(),
  }),
  /** Send own typing status for a private conversation. */
  TPN: z.object({ character: z.string(), status: z.enum(TYPING_STATUSES) }),
} as const;

export type ClientCommandName = keyof typeof clientCommandSchemas;

export type ClientCommandPayload<K extends ClientCommandName> = z.infer<
  (typeof clientCommandSchemas)[K]
>;

export type ClientCommand = {
  [K in ClientCommandName]: undefined extends ClientCommandPayload<K>
    ? { readonly cmd: K }
    : { readonly cmd: K; readonly payload: ClientCommandPayload<K> };
}[ClientCommandName];

export function isClientCommandName(cmd: string): cmd is ClientCommandName {
  return Object.hasOwn(clientCommandSchemas, cmd);
}

export function serializeClientCommand(command: ClientCommand): string {
  return serializeFrame(command);
}

/**
 * Parses a raw wire string sent by a client (used by fchat-sim). Never
 * throws; anything unknown, malformed, or schema-mismatched comes back as a
 * RawCommand.
 */
export function parseClientCommand(raw: string): ClientCommand | RawCommand {
  const result = parseFrame(raw);
  if (!result.ok) {
    return { cmd: raw.slice(0, 3), raw };
  }
  const { cmd, payload } = result.frame;
  if (!isClientCommandName(cmd)) {
    return { cmd, raw };
  }
  const parsed = clientCommandSchemas[cmd].safeParse(payload);
  if (!parsed.success) {
    return { cmd, raw };
  }
  return (
    parsed.data === undefined ? { cmd } : { cmd, payload: parsed.data }
  ) as ClientCommand;
}

export function isKnownClientCommand(
  command: ClientCommand | RawCommand,
): command is ClientCommand {
  return !("raw" in command);
}
