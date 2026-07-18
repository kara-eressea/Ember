// Friendly copy for the F-Chat ERR codes users actually hit (M9 step 4,
// wiki messages in design/chat-error-codes.md). Unknown codes fall back to
// the server's own message — never invent text for codes we don't know.

const FRIENDLY: Record<number, string> = {
  5: "Slow down a moment — F-Chat allows one channel message per second.",
  8: "F-Chat didn't recognize that command.",
  15: "That message is over the server's length limit — trim it or split it in two.",
  20: "They've chosen not to receive your messages (you may be on their ignore list).",
  26: "That channel doesn't seem to exist (private room ids are case-sensitive).",
  28: "You're already in that channel.",
  36: "F-Chat refused that roll — try a simple form like /roll 2d6.",
  44: "That channel is invite-only — someone inside has to invite you.",
  45: "You're not in that channel anymore, so the message wasn't sent.",
  48: "You're banned from that channel.",
  50: "Searches are limited to one every five seconds.",
  54: "Staff alerts are limited to one every two minutes — contact a moderator directly for corrections.",
  56: "Roleplay ads are paced by F-Chat: one per channel every ten minutes.",
  // 59 = ads refused (chat-only channel); 60 = chat refused (ads-only
  // channel) — wiki-verified, and the audit caught them swapped once:
  // tests below pin BOTH.
  59: "That channel is chat-only — roleplay ads aren't allowed there.",
  60: "That channel is ads-only — plain chat messages aren't allowed there.",
  62: "F-Chat has no free login slots right now — try again in a little while.",
  64: "Your ignore list is at F-Chat's 300-name cap.",
};

/** The notice-strip line for an ERR event. */
export function errNotice(number: number, message: string): string {
  const friendly = FRIENDLY[number];
  return friendly !== undefined
    ? `${friendly} (${String(number)})`
    : `${message} (${String(number)})`;
}
