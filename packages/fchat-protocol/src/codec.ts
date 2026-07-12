// F-Chat frame codec. Wire format: `XXX {json}` — a three-character
// uppercase command, optionally followed by a single space and a JSON
// payload. Bare commands (e.g. `PIN`) have no trailing space.
// See design/chat-protocol.md §Command Format.

export interface Frame {
  readonly cmd: string;
  readonly payload?: unknown;
}

/**
 * A command kept as raw text because it could not be parsed into a typed
 * command: unknown command name, schema-mismatched payload, or a malformed
 * frame. Callers log and swallow these (developer policy: never crash on
 * unknown commands).
 */
export interface RawCommand {
  readonly cmd: string;
  readonly raw: string;
}

export type FrameParseErrorReason =
  "too-short" | "bad-command" | "missing-separator" | "bad-json";

export type FrameParseResult =
  | { readonly ok: true; readonly frame: Frame }
  | {
      readonly ok: false;
      readonly reason: FrameParseErrorReason;
      readonly raw: string;
    };

const COMMAND_PATTERN = /^[A-Z]{3}$/;

/**
 * Parses a raw wire string into a frame. Never throws — malformed input
 * yields `{ ok: false }` (developer policy: never crash on bad input).
 */
export function parseFrame(raw: string): FrameParseResult {
  if (raw.length < 3) {
    return { ok: false, reason: "too-short", raw };
  }
  const cmd = raw.slice(0, 3);
  if (!COMMAND_PATTERN.test(cmd)) {
    return { ok: false, reason: "bad-command", raw };
  }
  if (raw.length === 3) {
    return { ok: true, frame: { cmd } };
  }
  if (raw[3] !== " ") {
    return { ok: false, reason: "missing-separator", raw };
  }
  const body = raw.slice(4);
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return { ok: false, reason: "bad-json", raw };
  }
  return { ok: true, frame: { cmd, payload } };
}

/**
 * Serializes a frame to its wire string. Frames without a payload
 * serialize to the bare command with no trailing space.
 *
 * Throws if `cmd` is not a three-character uppercase command — that is a
 * programming error in our own code, not untrusted input.
 */
export function serializeFrame(frame: Frame): string {
  if (!COMMAND_PATTERN.test(frame.cmd)) {
    throw new TypeError(`Invalid F-Chat command: ${JSON.stringify(frame.cmd)}`);
  }
  if (frame.payload === undefined) {
    return frame.cmd;
  }
  return `${frame.cmd} ${JSON.stringify(frame.payload)}`;
}
