// Channel role derivation (M6): COL's oplist is owner-first (may be "" for
// unowned official channels); everyone else is a plain member. This is the
// single gating primitive for role-dependent UI — the context menu's admin
// section and the RP/op tooling ask here. Chatops (global moderators, from
// ADL at login) outrank every channel role.

export type ChannelRole = "owner" | "op" | null;

/** The character's role in a channel, from the owner-first oplist.
 * Case-insensitive: COL carries canonical casing but callers may hold a
 * differently-cased spelling of their own nick. */
export function roleFor(
  character: string,
  oplist: readonly string[],
): ChannelRole {
  const needle = character.toLowerCase();
  const owner = (oplist[0] ?? "").toLowerCase();
  if (owner !== "" && owner === needle) {
    return "owner";
  }
  return oplist.slice(1).some((op) => op.toLowerCase() === needle)
    ? "op"
    : null;
}

/** Mono tag line for the context-menu header (§10). */
export function roleTag(role: ChannelRole): string {
  if (role === "owner") {
    return "owner ~";
  }
  if (role === "op") {
    return "channel op @";
  }
  return "member";
}

/** What the admin section offers against one target (M6 op tooling). */
export interface ModPowers {
  /** Kick / ban / timeout — removal actions share one rule. */
  remove: boolean;
  promote: boolean;
  demote: boolean;
  setOwner: boolean;
}

const NO_POWERS: ModPowers = {
  remove: false,
  promote: false,
  demote: false,
  setOwner: false,
};

/**
 * Mirrors the wire rules so the menu never offers a command the server
 * would refuse: chanops moderate, but ops are shielded from other ops
 * (only the owner or a chatop may remove them); the owner slot never
 * demotes (CSO moves ownership); handing the room over is owner-only.
 */
export function modPowers(input: {
  viewer: ChannelRole;
  viewerChatop: boolean;
  target: ChannelRole;
  self: boolean;
}): ModPowers {
  const { viewer, viewerChatop, target, self } = input;
  const isOp = viewer !== null || viewerChatop;
  const outranks = viewer === "owner" || viewerChatop;
  if (!isOp || self) {
    return NO_POWERS;
  }
  return {
    remove: target === null || outranks,
    promote: target === null,
    demote: target === "op",
    setOwner: outranks && target !== "owner",
  };
}
