// Documented value sets from design/server-commands.md / client-commands.md.
//
// Server-received fields are deliberately typed as plain strings in the
// command schemas (the live server may grow new values, and an unknown value
// must never make a whole command unparseable); these unions are for
// client-constructed commands and for downstream narrowing.

export const GENDERS = [
  "Male",
  "Female",
  "Transgender",
  "Herm",
  "Shemale",
  "Male-Herm",
  "Cunt-boy",
  "None",
] as const;
export type Gender = (typeof GENDERS)[number];

export const CHARACTER_STATUSES = [
  "online",
  "looking",
  "busy",
  "dnd",
  "idle",
  "away",
  "crown",
] as const;
export type CharacterStatus = (typeof CHARACTER_STATUSES)[number];

// "crown" is set only by the server (RWD) and must not be sent by a client.
export const CLIENT_SETTABLE_STATUSES = [
  "online",
  "looking",
  "busy",
  "dnd",
  "idle",
  "away",
] as const;
export type ClientSettableStatus = (typeof CLIENT_SETTABLE_STATUSES)[number];

export const TYPING_STATUSES = ["clear", "paused", "typing"] as const;
export type TypingStatus = (typeof TYPING_STATUSES)[number];

export const CHANNEL_MODES = ["chat", "ads", "both"] as const;
export type ChannelMode = (typeof CHANNEL_MODES)[number];
