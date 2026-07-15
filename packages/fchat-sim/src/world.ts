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
