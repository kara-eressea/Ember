// Server variables (VAR command). The defaults below are fallbacks matching
// the documented values at the time of writing — runtime VAR values from the
// server are always authoritative and must never be replaced by hardcoded
// limits (developer policy).

import type { ServerCommandPayload } from "./server-commands.js";

export interface ServerVars {
  /** Maximum number of bytes allowed with MSG. */
  readonly chat_max: number;
  /** Maximum number of bytes allowed with PRI. */
  readonly priv_max: number;
  /** Maximum number of bytes allowed with LRP. */
  readonly lfrp_max: number;
  /** Required seconds between LRP messages. */
  readonly lfrp_flood: number;
  /** Required seconds between MSG messages. */
  readonly msg_flood: number;
  /** Permissions mask for this character. */
  readonly permissions: number;
  /** Channels that do not allow (e)icons. */
  readonly icon_blacklist: readonly string[];
}

export const DEFAULT_SERVER_VARS: ServerVars = {
  chat_max: 4096,
  priv_max: 50000,
  lfrp_max: 50000,
  lfrp_flood: 600,
  msg_flood: 0.5,
  permissions: 0,
  icon_blacklist: [],
};

const NUMERIC_VARS = [
  "chat_max",
  "priv_max",
  "lfrp_max",
  "lfrp_flood",
  "msg_flood",
  "permissions",
] as const;

type NumericVar = (typeof NUMERIC_VARS)[number];

function isNumericVar(variable: string): variable is NumericVar {
  return (NUMERIC_VARS as readonly string[]).includes(variable);
}

/**
 * Applies a VAR payload to the current variables, returning an updated copy.
 * Unknown variables and unusable values leave the input unchanged — a new
 * server variable must never break the session.
 *
 * Numeric variables are coerced with Number() because the server sends some
 * of them as strings (e.g. `"permissions": "35868"`).
 */
export function applyVar(
  vars: ServerVars,
  payload: ServerCommandPayload<"VAR">,
): ServerVars {
  const { variable, value } = payload;
  if (isNumericVar(variable)) {
    if (Array.isArray(value)) {
      return vars;
    }
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) {
      return vars;
    }
    return { ...vars, [variable]: numeric };
  }
  if (variable === "icon_blacklist") {
    if (!Array.isArray(value)) {
      return vars;
    }
    return { ...vars, icon_blacklist: value };
  }
  return vars;
}
