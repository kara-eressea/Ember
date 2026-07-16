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
