// F-Chat error codes (design/chat-error-codes.md, server version 0.8-Lua).
// The ERR command carries the rendered message; the messages below are the
// documented templates (<...> marks a variable part).

export const FchatErrorCode = {
  Success: 0,
  SyntaxError: 1,
  NoFreeSlots: 2,
  LoginRequired: 3,
  IdentificationFailed: 4,
  MessageFlood: 5,
  CharacterNotFound: 6,
  ProfileRequestFlood: 7,
  UnknownCommand: 8,
  BannedFromServer: 9,
  AdminRequired: 10,
  AlreadyIdentified: 11,
  KinkRequestFlood: 13,
  MessageTooLong: 15,
  AlreadyGlobalModerator: 16,
  NotGlobalModerator: 17,
  NoSearchResults: 18,
  ModeratorRequired: 19,
  IgnoredByRecipient: 20,
  CannotTargetModerator: 21,
  ChannelNotFound: 26,
  AlreadyInChannel: 28,
  TooManyConnectionsFromIp: 30,
  LoggedInFromAnotherLocation: 31,
  AccountAlreadyBanned: 32,
  UnknownAuthMethod: 33,
  RollError: 36,
  InvalidTimeoutLength: 38,
  TimedOut: 39,
  KickedFromChat: 40,
  AlreadyBannedFromChannel: 41,
  NotBannedFromChannel: 42,
  InviteRequired: 44,
  NotInChannel: 45,
  CannotInviteToPublicChannel: 47,
  BannedFromChannel: 48,
  CharacterNotInChannel: 49,
  SearchFlood: 50,
  ReportFlood: 54,
  AdFlood: 56,
  ChatOnlyChannel: 59,
  AdsOnlyChannel: 60,
  TooManySearchTerms: 61,
  NoFreeLoginSlots: 62,
  IgnoreListTooLong: 64,
  ChannelTitleTooLong: 67,
  TooManySearchResults: 72,
  FatalInternalError: -1,
  CommandProcessingError: -2,
  NotImplemented: -3,
  LoginServerTimeout: -4,
  UnknownError: -5,
  FrontpageRollProhibited: -10,
} as const;

export type FchatErrorCode =
  (typeof FchatErrorCode)[keyof typeof FchatErrorCode];

/**
 * The "channel gone / not-in-channel" family: the server telling us a
 * channel we referenced no longer holds us — a private room destroyed while
 * we were detached (F-Chat reaps empty ADH- rooms), or a join/leave against
 * a key we're not actually in. For a leave these mean the leave is already
 * effectively done; for a join they mean the room can't be joined. Treated
 * as a completed/settled leave rather than a surfaced dead-end error (#327).
 */
export function isChannelGoneError(code: number): boolean {
  return (
    code === FchatErrorCode.ChannelNotFound || // 26
    code === FchatErrorCode.NotInChannel || // 45
    code === FchatErrorCode.CharacterNotInChannel // 49
  );
}

export const FCHAT_ERROR_MESSAGES: Readonly<Record<number, string>> = {
  0: "Operation completed successfully.",
  1: "Syntax error.",
  2: "There are no free slots left for you to connect to.",
  3: "This command requires that you have logged in.",
  4: "Identification failed.",
  5: "You must wait one second between sending channel messages.",
  6: "The character requested was not found.",
  7: "You must wait ten seconds between requesting profiles.",
  8: "Unknown command.",
  9: "You are banned from the server.",
  10: "This command requires that you be an administrator.",
  11: "Already identified.",
  13: "You must wait ten seconds between requesting kinks.",
  15: "Message exceeded the maximum length.",
  16: "This character is already a global moderator.",
  17: "This character is not a global moderator.",
  18: "There were no search results.",
  19: "This command requires that you be a moderator.",
  20: "<character name> does not wish to receive messages from you.",
  21: "This action can not be used on a moderator or administrator.",
  26: "Could not locate the requested channel.",
  28: "You are already in the requested channel.",
  30: "There are too many connections from your IP.",
  31: "You have been disconnected because this character has been logged in at another location.",
  32: "That account is already banned.",
  33: "Unknown authentication method requested.",
  36: "There was a problem with your roll command.",
  38: "The time given for the timeout was invalid. It must be a number between 1 and 90 minutes.",
  39: "You have been given a time out by <moderator name> for <length> minute(s). The reason given was: <reason>",
  40: "You have been kicked from chat.",
  41: "This character is already banned from the channel.",
  42: "This character is not currently banned from the channel.",
  44: "You may only join the requested channel with an invite.",
  45: "You must be in a channel to send messages to it.",
  47: "You may not invite others to a public channel.",
  48: "You are banned from the requested channel.",
  49: "That character was not found in the channel.",
  50: "You must wait five seconds between searches.",
  54: "Please wait two minutes between calling moderators. If you need to make an addition or a correction to a report, please contact a moderator directly.",
  56: "You may only post a role play ad to a channel every ten minutes.",
  59: "This channel does not allow role play ads, only chat messages.",
  60: "This channel does not allow chat messages, only role play ads.",
  61: "There were too many search terms.",
  62: "There are currently no free login slots.",
  64: "Your ignore list may not exceed 300 people.",
  67: "Channel titles may not exceed 64 characters in length.",
  72: "There are too many search results, please narrow your search.",
  [-1]: "Fatal internal error.",
  [-2]: "An error occurred while processing your command.",
  [-3]: "This command has not been implemented yet.",
  [-4]: "A connection to the login server timed out. Please try again in a moment.",
  [-5]: "An unknown error occurred.",
  [-10]: "You may not roll dice or spin the bottle in Frontpage.",
};
