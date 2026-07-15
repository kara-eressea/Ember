// Send-side slash commands (M6): parsed from the raw composer text before
// any Markdown translation. Deliberately a small registry — op tooling adds
// more in step 6. "/me" is not a command here: it is part of the message
// body (F-Chat renders it as an emote) and must reach the wire untouched.

export type SlashCommand =
  | { type: "roll"; dice: string }
  | { type: "bottle" }
  | { type: "unknown"; name: string };

/** The documented RLL grammar, checked client-side for a friendly error
 * before the wire (the server/sim still validates authoritatively). */
const DICE_EXPR = /^[1-9]d[1-9]\d{0,2}(\+([1-9]d[1-9]\d{0,2}|\d{1,5}))*$/;

export class SlashUsageError extends Error {}

/**
 * Undefined = not a slash command (send the text as a message). Throws
 * SlashUsageError when the command is recognized but malformed.
 */
export function parseSlash(text: string): SlashCommand | undefined {
  if (!text.startsWith("/") || text.startsWith("/me")) {
    return undefined;
  }
  const [word = "", ...rest] = text.slice(1).split(/\s+/);
  const name = word.toLowerCase();
  const args = rest.join(" ").trim();
  switch (name) {
    case "roll": {
      const dice = args === "" ? "1d20" : args;
      if (!DICE_EXPR.test(dice)) {
        throw new SlashUsageError(
          "Usage: /roll 2d6 (up to 20 dice sets and +N bonuses)",
        );
      }
      return { type: "roll", dice };
    }
    case "bottle":
      return { type: "bottle" };
    default:
      return { type: "unknown", name };
  }
}
