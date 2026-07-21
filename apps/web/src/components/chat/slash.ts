// Send-side slash commands (M6): parsed from the raw composer text before
// any Markdown translation. "/me" is not a command here: it is part of the
// message body (F-Chat renders it as an emote) and must reach the wire
// untouched.

/** Moderation commands that take exactly one character argument. */
export const MOD_ACTIONS = {
  kick: "channel.kick",
  ban: "channel.ban",
  unban: "channel.unban",
  op: "channel.promote",
  deop: "channel.demote",
  setowner: "channel.owner",
} as const;

export type ModAction = (typeof MOD_ACTIONS)[keyof typeof MOD_ACTIONS];

export type SlashCommand =
  | { type: "roll"; dice: string }
  | { type: "bottle" }
  | { type: "mod"; action: ModAction; character: string }
  | { type: "timeout"; character: string; minutes: number }
  | { type: "setmode"; mode: "ads" | "both" | "chat" }
  | { type: "banlist" }
  | { type: "help" }
  | { type: "unknown"; name: string };

/** The documented RLL grammar, checked client-side for a friendly error
 * before the wire (the server/sim still validates authoritatively). */
const DICE_EXPR = /^[1-9]d[1-9]\d{0,2}(\+([1-9]d[1-9]\d{0,2}|\d{1,5}))*$/;

/** Mirrors the sim/server grammar so refusals stay friendly and inline
 * instead of an async ERR 36: ≤20 terms, sides ≤500, flat bonuses ≤10000. */
function diceWithinBounds(dice: string): boolean {
  const terms = dice.split("+");
  if (terms.length > 20) {
    return false;
  }
  return terms.every((term) => {
    const die = /^[1-9]d([1-9]\d{0,2})$/.exec(term);
    if (die) {
      return Number(die[1]) <= 500;
    }
    return Number(term) <= 10_000;
  });
}

export class SlashUsageError extends Error {}

// ── Autocomplete catalog (#235) ─────────────────────────────────────────────
// The set the composer offers inline as you type. Descriptions stay plain —
// no wire/BBCode jargon. `mod` gates the entry behind a channel role (see
// suggestCommands); `channelOnly` hides it in DMs, where these do nothing.

export interface SlashHint {
  /** Bare command word, lowercase (no leading slash). */
  name: string;
  /** Signature shown next to the name, e.g. "/timeout <character>, <minutes>". */
  usage: string;
  /** One-line, plain-language description. */
  description: string;
  /** Requires a moderator role in the active channel to be offered. */
  mod: boolean;
  /** Only meaningful inside a channel (hidden in direct messages). */
  channelOnly: boolean;
}

export const SLASH_COMMANDS: readonly SlashHint[] = [
  {
    name: "me",
    usage: "/me <action>",
    description: "Act out something — posts as an emote, not a command",
    mod: false,
    channelOnly: false,
  },
  {
    name: "roll",
    usage: "/roll <dice>",
    description: "Roll dice, like 2d6+3 (defaults to 1d20)",
    mod: false,
    channelOnly: true,
  },
  {
    name: "bottle",
    usage: "/bottle",
    description: "Spin the bottle to pick someone at random",
    mod: false,
    channelOnly: true,
  },
  {
    name: "help",
    usage: "/help",
    description: "Open the commands & formatting guide",
    mod: false,
    channelOnly: false,
  },
  {
    name: "setmode",
    usage: "/setmode chat | ads | both",
    description: "Choose what this channel accepts",
    mod: true,
    channelOnly: true,
  },
  {
    name: "banlist",
    usage: "/banlist",
    description: "List who is banned from this channel",
    mod: true,
    channelOnly: true,
  },
  {
    name: "timeout",
    usage: "/timeout <character>, <minutes>",
    description: "Mute someone here for a while (up to 90 minutes)",
    mod: true,
    channelOnly: true,
  },
  {
    name: "kick",
    usage: "/kick <character>",
    description: "Remove someone from this channel",
    mod: true,
    channelOnly: true,
  },
  {
    name: "ban",
    usage: "/ban <character>",
    description: "Ban someone from this channel",
    mod: true,
    channelOnly: true,
  },
  {
    name: "unban",
    usage: "/unban <character>",
    description: "Lift someone's ban from this channel",
    mod: true,
    channelOnly: true,
  },
  {
    name: "op",
    usage: "/op <character>",
    description: "Make someone a channel operator",
    mod: true,
    channelOnly: true,
  },
  {
    name: "deop",
    usage: "/deop <character>",
    description: "Take away someone's operator status",
    mod: true,
    channelOnly: true,
  },
  {
    name: "setowner",
    usage: "/setowner <character>",
    description: "Hand this channel over to someone else",
    mod: true,
    channelOnly: true,
  },
];

export interface SlashContext {
  /** The conversation is a channel (not a DM). */
  inChannel: boolean;
  /** The current identity may run moderation commands in this channel. */
  canModerate: boolean;
}

/**
 * Commands to offer for the current composer text. Empty = no popover.
 *
 * While the command word is still being typed ("/ba"), every command whose
 * name starts with it is offered. Once a separator follows the word
 * ("/ban Kestrel"), only the one matching command remains, so its signature
 * keeps showing as a hint instead of only erroring on send. Moderation and
 * channel-only entries are filtered by the caller-supplied context.
 */
export function suggestCommands(text: string, ctx: SlashContext): SlashHint[] {
  if (!text.startsWith("/")) {
    return [];
  }
  const afterSlash = text.slice(1);
  const typingArgs = /\s/.test(afterSlash);
  const word = (afterSlash.split(/\s+/)[0] ?? "").toLowerCase();
  const available = SLASH_COMMANDS.filter(
    (command) =>
      (!command.channelOnly || ctx.inChannel) &&
      (!command.mod || ctx.canModerate),
  );
  if (typingArgs) {
    // Args in flight: /me is an emote, not a command — no lingering hint.
    if (word === "me") {
      return [];
    }
    const exact = available.find((command) => command.name === word);
    return exact ? [exact] : [];
  }
  return available.filter((command) => command.name.startsWith(word));
}

/**
 * Undefined = not a slash command (send the text as a message). Throws
 * SlashUsageError when the command is recognized but malformed.
 */
export function parseSlash(text: string): SlashCommand | undefined {
  if (!text.startsWith("/") || /^\/me\b|^\/me'/.test(text)) {
    return undefined;
  }
  const [word = "", ...rest] = text.slice(1).split(/\s+/);
  const name = word.toLowerCase();
  const args = rest.join(" ").trim();
  switch (name) {
    case "roll": {
      const dice = args === "" ? "1d20" : args;
      if (!DICE_EXPR.test(dice) || !diceWithinBounds(dice)) {
        throw new SlashUsageError(
          "Usage: /roll 2d6 (up to 20 dice sets and +N bonuses)",
        );
      }
      return { type: "roll", dice };
    }
    case "bottle":
      return { type: "bottle" };
    case "timeout": {
      // "/timeout <character>, <minutes>" — names can contain spaces, so
      // the comma is the separator.
      const [who = "", rawMinutes = ""] = args.split(",");
      const character = who.trim();
      const minutes = Number(rawMinutes.trim());
      if (
        character === "" ||
        !Number.isInteger(minutes) ||
        minutes < 1 ||
        minutes > 90
      ) {
        throw new SlashUsageError(
          "Usage: /timeout <character>, <minutes> (1-90)",
        );
      }
      return { type: "timeout", character, minutes };
    }
    case "setmode": {
      if (args !== "chat" && args !== "ads" && args !== "both") {
        throw new SlashUsageError("Usage: /setmode chat | ads | both");
      }
      return { type: "setmode", mode: args };
    }
    case "banlist":
      return { type: "banlist" };
    case "help":
      return { type: "help" };
    default: {
      if (Object.hasOwn(MOD_ACTIONS, name)) {
        if (args === "") {
          throw new SlashUsageError(`Usage: /${name} <character>`);
        }
        return {
          type: "mod",
          action: MOD_ACTIONS[name as keyof typeof MOD_ACTIONS],
          character: args,
        };
      }
      return { type: "unknown", name };
    }
  }
}
