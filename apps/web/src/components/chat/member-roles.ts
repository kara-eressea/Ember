// Channel role derivation (M6): COL's oplist is owner-first (may be "" for
// unowned official channels); everyone else is a plain member. This is the
// single gating primitive for role-dependent UI — the context menu's admin
// section and the RP/op tooling (M6 steps 5–6) all ask here. Chatops (ADL)
// join in step 6.

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
