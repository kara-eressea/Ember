// The fake world the sim serves: accounts, channels, and NPC characters that
// are "online" without a socket behind them. Everything here is fixture data
// — never real F-List credentials.

import type { ChannelMode } from "@emberchat/fchat-protocol";

export interface SimAccount {
  readonly password: string;
  readonly characters: readonly string[];
}

export interface SimChannelSeed {
  /** Channel name (official) or ADH- ID (private room). */
  readonly name: string;
  /** Display title for private rooms; official channels use the name. */
  readonly title?: string;
  readonly mode: ChannelMode;
  readonly description: string;
  /** Channel ops; first entry is the owner ("" for unowned official channels). */
  readonly oplist?: readonly string[];
  /** NPCs seeded as members. */
  readonly npcs?: readonly string[];
  /** false = hidden/invite-only room: joinable by exact name but never
   * returned in ORS listings (real ADH- rooms behave this way when closed).
   * Official channels are always listed. */
  readonly listed?: boolean;
}

export interface SimNpc {
  readonly name: string;
  readonly gender: string;
  readonly status: string;
  readonly statusmsg: string;
}

export interface SimWorld {
  readonly accounts: Readonly<Record<string, SimAccount>>;
  readonly channels: readonly SimChannelSeed[];
  readonly npcs: readonly SimNpc[];
}

export const DEFAULT_WORLD: SimWorld = {
  accounts: {
    "amber@example.test": {
      password: "hunter2",
      characters: ["Amber Vale", "Cindral"],
    },
    "birch@example.test": {
      password: "hunter2",
      characters: ["Birch Rowan"],
    },
    // Reserved for the M2 bouncer E2E — spec files run in parallel and a
    // character can hold only one sim connection, so specs never share one.
    "willow@example.test": {
      password: "hunter2",
      characters: ["Willow Reed", "Fern Ashwood"],
    },
    // Reserved for the M3 multi-identity rail E2E (same parallelism rule);
    // Bramble is its raw-SimClient "other side".
    "rowan@example.test": {
      password: "hunter2",
      characters: ["Rowan Redleaf", "Petal Thorn"],
    },
    "thorn@example.test": {
      password: "hunter2",
      characters: ["Bramble Thorn"],
    },
    // Reserved for the M4 compose/delayed-send E2E (same parallelism rule).
    "sage@example.test": {
      password: "hunter2",
      characters: ["Sage Willowmere"],
    },
    // Reserved for the M5 preferences E2E (same parallelism rule);
    // Fenwick Sprout is its raw-SimClient "other side".
    "hazel@example.test": {
      password: "hunter2",
      characters: ["Hazel Fenwick", "Fenwick Sprout"],
    },
    // Reserved for the M6 channel-browser E2E (same parallelism rule);
    // Quince Pip is its raw-SimClient "other side" (room owner, inviter).
    "laurel@example.test": {
      password: "hunter2",
      characters: ["Laurel Quince", "Quince Pip"],
    },
    // Reserved for the M6 RP-messages E2E (same parallelism rule); Moss
    // Tinker is its raw-SimClient "other side" (Greenhouse op, ad sender).
    "ivy@example.test": {
      password: "hunter2",
      characters: ["Ivy Bramblewood", "Moss Tinker"],
    },
  },
  channels: [
    {
      name: "Frontpage",
      mode: "chat",
      description: "The sim's default hangout. [b]Be nice.[/b]",
      oplist: ["", "Nyx Firemane"],
      npcs: ["Nyx Firemane", "Tally Marsh", "Old Greywhisker"],
    },
    {
      name: "Development",
      mode: "both",
      description: "Talk about third-party clients here.",
      npcs: ["Tally Marsh"],
    },
    // Reserved for the rail E2E: chat.spec asserts exact Frontpage member
    // counts, so parallel specs must not wander in — channel isolation
    // follows the same rule as character isolation.
    {
      name: "Gardening",
      mode: "chat",
      description: "Seeds, cuttings, and quiet company.",
      npcs: ["Tally Marsh"],
    },
    // Reserved for the M5 preferences E2E (join/part/quit lines).
    {
      name: "Terrarium",
      mode: "both",
      description: "Small glass worlds.",
      npcs: [],
    },
    {
      name: "ADH-1a2b3c4d5e6f7a8b9c0d",
      title: "Ember Lounge",
      mode: "both",
      description: "A private open room with an [i]ID[/i] instead of a name.",
      oplist: ["Nyx Firemane"],
      npcs: ["Nyx Firemane"],
    },
    // Reserved for the M6 channel-browser E2E (join through the dialog).
    {
      name: "Orchard",
      mode: "chat",
      description: "Rows of quiet trees.",
      npcs: ["Tally Marsh"],
    },
    // Hidden room for the browser's join-by-name footer: joinable by exact
    // id, never listed in ORS.
    {
      name: "ADH-9f8e7d6c5b4a39281706",
      title: "Root Cellar",
      mode: "chat",
      description: "You had to be told about this place.",
      oplist: ["Nyx Firemane"],
      npcs: ["Nyx Firemane"],
      listed: false,
    },
    // Reserved for the M6 RP-messages E2E: mode "both" so ads and the
    // composer's Ad toggle are live; hidden so listing counts elsewhere
    // stay stable; no NPCs so /bottle is deterministic.
    {
      name: "ADH-77aa88bb99cc00dd11ee",
      title: "Greenhouse",
      mode: "both",
      description: "Warm glass and growing things.",
      oplist: ["Moss Tinker"],
      npcs: [],
      listed: false,
    },
  ],
  npcs: [
    { name: "Nyx Firemane", gender: "Female", status: "online", statusmsg: "" },
    {
      name: "Tally Marsh",
      gender: "Male",
      status: "looking",
      statusmsg: "Open for scenes!",
    },
    {
      name: "Old Greywhisker",
      gender: "None",
      status: "busy",
      statusmsg: "Lurking.",
    },
  ],
};
