// Presence-dot mapping (COMPONENTS.md §Presence system). F-Chat statuses:
// online/looking/crown read as available (ok dot); idle/away/busy/dnd read
// as idle (warn dot). Offline rows use the faint dot and half opacity.

export type DotKind = "ok" | "warn" | "faint";

export function presenceDot(online: boolean, status: string): DotKind {
  if (!online) {
    return "faint";
  }
  switch (status) {
    case "online":
    case "looking":
    case "crown":
    case "":
      return "ok";
    default:
      return "warn";
  }
}
